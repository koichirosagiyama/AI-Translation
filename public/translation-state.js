function stripMarkdownFence(text) {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function isJsonLike(text) {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.includes('"action"') || trimmed.includes('"text"');
}

function normalizeSpeaker(value) {
  if (value === "interviewer" || value === "respondent") return value;
  return "unknown";
}

function normalizeParsedResult(parsed) {
  if (!parsed || typeof parsed !== "object") return { action: "append", text: "" };

  if (parsed.action === "revise_many") {
    const revisions = Array.isArray(parsed.revisions)
      ? parsed.revisions
          .filter((item) => item && typeof item.id === "string" && typeof item.text === "string")
          .slice(0, 4)
          .map((item) => ({ id: item.id.trim(), speaker: normalizeSpeaker(item.speaker), text: item.text.trim() }))
          .filter((item) => item.id && item.text)
      : [];
    const delete_ids = Array.isArray(parsed.delete_ids)
      ? parsed.delete_ids.filter((id) => typeof id === "string" && id.trim()).slice(0, 4).map((id) => id.trim())
      : [];
    const append_text = typeof parsed.append_text === "string" ? parsed.append_text.trim() : "";
    const append_speaker = normalizeSpeaker(parsed.append_speaker);
    return { action: "revise_many", revisions, delete_ids, append_text, append_speaker };
  }

  const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
  if (!text) return { action: "append", text: "" };

  if (parsed.action === "revise" && typeof parsed.revise_id === "string" && parsed.revise_id.trim()) {
    return { action: "revise", revise_id: parsed.revise_id.trim(), speaker: normalizeSpeaker(parsed.speaker), text };
  }

  if (parsed.action === "append" || !parsed.action) {
    return { action: "append", speaker: normalizeSpeaker(parsed.speaker), text };
  }

  return { action: "append", text: "" };
}

export function parseTranslationResult(text) {
  const raw = String(text || "").trim();
  if (!raw) return { action: "append", text: "" };

  const unfenced = stripMarkdownFence(raw);
  const candidates = [
    unfenced,
    unfenced.replace(/^[=>(\s]+/, "").replace(/[)\s]+$/, ""),
  ];
  const jsonMatch = unfenced.match(/\{[\s\S]*\}/);
  if (jsonMatch) candidates.unshift(jsonMatch[0]);

  for (const candidate of candidates) {
    try {
      return normalizeParsedResult(JSON.parse(candidate.trim().replace(/^=+\s*/, "")));
    } catch {
      // Try the next candidate.
    }
  }

  if (isJsonLike(unfenced)) return { action: "append", text: "" };
  return { action: "append", text: unfenced };
}

export function formatTranslation(items) {
  return items
    .map((item) => item.text?.trim() || "")
    .filter((text) => text && !isJsonLike(text))
    .join("\n");
}

export function applyTranslationResult(state, result) {
  const now = result.now ?? Date.now();
  const sourceEnglish = result.sourceEnglish?.trim() || "";

  if (result.action === "revise_many") {
    let changed = false;
    const deleteIds = new Set(result.delete_ids || []);

    for (const revision of result.revisions || []) {
      const target = state.target.find((item) => item.id === revision.id);
      const text = revision.text?.trim();
      if (!target || !text || isJsonLike(text)) continue;
      if (target.text !== text) {
        target.text = text;
        target.speaker = normalizeSpeaker(revision.speaker);
        target.updated = true;
        target.revisedAt = now;
        changed = true;
      }
      if (sourceEnglish) {
        target.sourceEnglish = [target.sourceEnglish, sourceEnglish].filter(Boolean).join("\n");
      }
    }

    if (deleteIds.size) {
      const before = state.target.length;
      state.target = state.target.filter((item) => !deleteIds.has(item.id));
      changed = changed || state.target.length !== before;
    }

    const appendText = result.append_text?.trim();
    if (appendText && !isJsonLike(appendText) && state.target.at(-1)?.text !== appendText) {
      state.target.push({
        id: `ja_${now}_${state.target.length}`,
        text: appendText,
        speaker: normalizeSpeaker(result.append_speaker),
        sourceEnglish,
        updated: false,
        createdAt: now,
        revisedAt: undefined,
      });
      changed = true;
    }

    return { changed, action: "revise_many" };
  }

  const text = result?.text?.trim();
  if (!text || isJsonLike(text)) return { changed: false };

  if (result.action === "revise" && result.revise_id) {
    const target = state.target.find((item) => item.id === result.revise_id);
    if (target) {
      if (target.text === text && !sourceEnglish) return { changed: false };
      target.text = text;
      target.speaker = normalizeSpeaker(result.speaker);
      target.updated = true;
      target.revisedAt = now;
      if (sourceEnglish) {
        target.sourceEnglish = [target.sourceEnglish, sourceEnglish].filter(Boolean).join("\n");
      }
      return { changed: true, id: target.id, action: "revise" };
    }
  }

  const last = state.target.at(-1);
  if (last?.text === text) return { changed: false };

  const item = {
    id: `ja_${now}_${state.target.length}`,
    text,
    speaker: normalizeSpeaker(result.speaker),
    sourceEnglish,
    updated: false,
    createdAt: now,
    revisedAt: undefined,
  };
  state.target.push(item);
  return { changed: true, id: item.id, action: "append" };
}

function recentEnglishLines(source, limit = 8) {
  return String(source || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit);
}

export function buildTranslationRequestPayload(state, newEnglish, contextSize = 6) {
  return {
    new_english: newEnglish.trim(),
    previous_english: recentEnglishLines(state.source),
    style: {
      audience: "Japanese live captions",
      goal: "clear, natural, context-aware meaning rather than word-for-word translation",
    },
    recent_captions: state.target.slice(-contextSize).map((item) => ({
      id: item.id,
      speaker: normalizeSpeaker(item.speaker),
      english: item.sourceEnglish || "",
      japanese: item.text,
      updated: Boolean(item.updated),
    })),
  };
}

export function buildTranslationInstructions() {
  return [
    "You are a senior live English-to-Japanese caption editor.",
    "Input JSON has new_english, previous_english, style, and recent_captions.",
    "Classify each caption speaker as interviewer, respondent, or unknown.",
    "In interviews, interviewer usually asks questions or introduces the guest; respondent usually answers, explains, or gives opinions.",
    "Write clear, natural Japanese captions that preserve the speaker's meaning.",
    "Prefer context-aware Japanese over word-for-word translation.",
    "Use previous_english and recent_captions to resolve pronouns, omitted subjects, terminology, and phrase boundaries.",
    "Before answering, consider whether the newest English changes the meaning of the 3-4 recent captions.",
    "If the new English makes an earlier Japanese caption unclear, misleading, too literal, or incomplete, revise that caption instead of appending a separate correction.",
    "When revising, return the full corrected Japanese caption for the existing id.",
    "If several recent fragments belong together, use revise_many to rewrite up to 4 recent captions and delete fragments that became redundant.",
    "Only revise a recent caption when the new context materially improves meaning or readability.",
    "If the new English starts a new idea, append a new caption.",
    "Keep captions concise, readable, and natural for Japanese viewers.",
    "Do not add explanations, speaker labels, or content that is not supported by the English.",
    "Remove filler only when it improves readability without changing nuance.",
    "Return strict JSON only: {\"action\":\"append\",\"speaker\":\"interviewer|respondent|unknown\",\"text\":\"...\"}, {\"action\":\"revise\",\"revise_id\":\"...\",\"speaker\":\"interviewer|respondent|unknown\",\"text\":\"...\"}, or {\"action\":\"revise_many\",\"revisions\":[{\"id\":\"...\",\"speaker\":\"interviewer|respondent|unknown\",\"text\":\"...\"}],\"delete_ids\":[\"...\"],\"append_text\":\"...\",\"append_speaker\":\"interviewer|respondent|unknown\"}.",
    "Do not include markdown.",
  ].join(" ");
}
