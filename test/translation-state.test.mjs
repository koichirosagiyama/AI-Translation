import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTranslationResult,
  buildTranslationInstructions,
  buildTranslationRequestPayload,
  formatTranslation,
  parseTranslationResult,
} from "../public/translation-state.js";

test("parseTranslationResult extracts text from valid structured output", () => {
  assert.deepEqual(parseTranslationResult('{"action":"append","speaker":"interviewer","text":"こんにちは。"}'), {
    action: "append",
    speaker: "interviewer",
    text: "こんにちは。",
  });
});

test("parseTranslationResult accepts fenced JSON but never exposes JSON as caption text", () => {
  assert.deepEqual(parseTranslationResult('```json\n{"action":"append","text":"今日は寒いですね。"}\n```'), {
    action: "append",
    speaker: "unknown",
    text: "今日は寒いですね。",
  });
});

test("parseTranslationResult drops malformed JSON-like output instead of displaying it", () => {
  assert.deepEqual(parseTranslationResult('{"action":"append","text":"壊れた字幕"'), {
    action: "append",
    text: "",
  });
});

test("parseTranslationResult uses plain Japanese fallback for non-JSON output", () => {
  assert.deepEqual(parseTranslationResult("今日は会議の予定を確認します。"), {
    action: "append",
    text: "今日は会議の予定を確認します。",
  });
});

test("parseTranslationResult accepts multi-caption revision output", () => {
  assert.deepEqual(
    parseTranslationResult(
      JSON.stringify({
        action: "revise_many",
        revisions: [
          { id: "ja_1", text: "未来については多くの議論があります。" },
          { id: "ja_2", speaker: "respondent", text: "多くの人が未来を悲観しています。" },
        ],
        delete_ids: ["ja_3"],
        append_text: "それでも、前向きに考える余地はあります。",
        append_speaker: "respondent",
      }),
    ),
    {
      action: "revise_many",
      revisions: [
        { id: "ja_1", speaker: "unknown", text: "未来については多くの議論があります。" },
        { id: "ja_2", speaker: "respondent", text: "多くの人が未来を悲観しています。" },
      ],
      delete_ids: ["ja_3"],
      append_text: "それでも、前向きに考える余地はあります。",
      append_speaker: "respondent",
    },
  );
});

test("applyTranslationResult appends source-aware captions and ignores duplicates", () => {
  const state = { target: [] };

  const first = applyTranslationResult(state, {
    action: "append",
    speaker: "interviewer",
    text: "予算について話しましょう。",
    sourceEnglish: "Let's talk about the budget.",
    now: 1000,
  });
  const duplicate = applyTranslationResult(state, {
    action: "append",
    text: "予算について話しましょう。",
    sourceEnglish: "Let's talk about the budget.",
    now: 1100,
  });

  assert.equal(first.changed, true);
  assert.equal(duplicate.changed, false);
  assert.deepEqual(state.target, [
    {
      id: "ja_1000_0",
      text: "予算について話しましょう。",
      speaker: "interviewer",
      sourceEnglish: "Let's talk about the budget.",
      updated: false,
      createdAt: 1000,
      revisedAt: undefined,
    },
  ]);
});

test("applyTranslationResult revises an existing caption with later context", () => {
  const state = {
    target: [
      {
        id: "ja_1",
        text: "それをテーブルに置いてください。",
        speaker: "respondent",
        sourceEnglish: "Put it on the table.",
        updated: false,
        createdAt: 1000,
      },
    ],
  };

  const result = applyTranslationResult(state, {
    action: "revise",
    revise_id: "ja_1",
    speaker: "respondent",
    text: "それを表に載せてください。",
    sourceEnglish: "Actually, I mean the table in the report.",
    now: 2000,
  });

  assert.equal(result.changed, true);
  assert.deepEqual(state.target[0], {
    id: "ja_1",
    text: "それを表に載せてください。",
    speaker: "respondent",
    sourceEnglish: "Put it on the table.\nActually, I mean the table in the report.",
    updated: true,
    createdAt: 1000,
    revisedAt: 2000,
  });
});

test("applyTranslationResult revises and removes multiple recent captions", () => {
  const state = {
    target: [
      { id: "ja_1", text: "これは", speaker: "unknown", sourceEnglish: "This is", updated: false, createdAt: 1000 },
      { id: "ja_2", text: "あまり良くありません。つまり、", speaker: "respondent", sourceEnglish: "It's not great. I mean,", updated: false, createdAt: 1100 },
      { id: "ja_3", text: "そして、私は思います", speaker: "respondent", sourceEnglish: "and I think", updated: false, createdAt: 1200 },
      { id: "ja_4", text: "多くの人が未来に悲観的になっています。", speaker: "interviewer", sourceEnglish: "A lot of people are sad about the future.", updated: false, createdAt: 1300 },
    ],
  };

  const result = applyTranslationResult(state, {
    action: "revise_many",
    revisions: [
      { id: "ja_2", speaker: "respondent", text: "正直なところ、状況はあまり良くありません。" },
      { id: "ja_4", speaker: "interviewer", text: "多くの人が未来に不安を感じています。" },
    ],
    delete_ids: ["ja_1", "ja_3"],
    append_text: "だからこそ、未来について前向きに考えることが大切です。",
    append_speaker: "interviewer",
    sourceEnglish: "You want to think about the future.",
    now: 2000,
  });

  assert.equal(result.changed, true);
  assert.deepEqual(
    state.target.map((item) => ({ id: item.id, text: item.text, speaker: item.speaker, updated: item.updated })),
    [
      { id: "ja_2", text: "正直なところ、状況はあまり良くありません。", speaker: "respondent", updated: true },
      { id: "ja_4", text: "多くの人が未来に不安を感じています。", speaker: "interviewer", updated: true },
      { id: "ja_2000_2", text: "だからこそ、未来について前向きに考えることが大切です。", speaker: "interviewer", updated: false },
    ],
  );
});

test("buildTranslationRequestPayload includes recent source and Japanese context", () => {
  const state = {
    source: "Earlier context.\nThe product launch was delayed.\n",
    target: [
      { id: "ja_1", text: "最初です。", speaker: "interviewer", sourceEnglish: "First.", updated: false },
      { id: "ja_2", text: "次です。", speaker: "respondent", sourceEnglish: "Next.", updated: true },
    ],
  };

  assert.deepEqual(buildTranslationRequestPayload(state, "It depends on the context."), {
    new_english: "It depends on the context.",
    previous_english: ["Earlier context.", "The product launch was delayed."],
    style: {
      audience: "Japanese live captions",
      goal: "clear, natural, context-aware meaning rather than word-for-word translation",
    },
    recent_captions: [
      { id: "ja_1", speaker: "interviewer", english: "First.", japanese: "最初です。", updated: false },
      { id: "ja_2", speaker: "respondent", english: "Next.", japanese: "次です。", updated: true },
    ],
  });
});

test("buildTranslationInstructions asks the model to revise unclear captions using context", () => {
  const instructions = buildTranslationInstructions();

  assert.match(instructions, /clear, natural Japanese/);
  assert.match(instructions, /previous_english/);
  assert.match(instructions, /3-4 recent captions/);
  assert.match(instructions, /revise_many/);
  assert.match(instructions, /speaker/);
  assert.match(instructions, /interviewer/);
  assert.match(instructions, /respondent/);
  assert.match(instructions, /revise/i);
  assert.match(instructions, /word-for-word/);
  assert.match(instructions, /Return strict JSON only/);
});

test("formatTranslation renders caption text in chronological order", () => {
  assert.equal(
    formatTranslation([
      { text: "先の字幕です。" },
      { text: '{"action":"append","text":"これは出さない"}' },
      { text: "新しい字幕です。" },
    ]),
    "先の字幕です。\n新しい字幕です。",
  );
});
