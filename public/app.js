import { createAudioInputStream, stopAudioInput } from "./audio-source.js";
import {
  applyTranslationResult,
  buildTranslationInstructions,
  buildTranslationRequestPayload,
  parseTranslationResult,
} from "./translation-state.js";

const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const clearButton = document.querySelector("#clearButton");
const audioToggle = document.querySelector("#audioToggle");
const inputMode = document.querySelector("#inputMode");
const statusEl = document.querySelector("#status");
const noticeEl = document.querySelector("#notice");
const sourceText = document.querySelector("#sourceText");
const targetText = document.querySelector("#targetText");
const logEl = document.querySelector("#log");
const meter = document.querySelector(".meter");
const wavePath = document.querySelector("#wavePath");
const waveFill = document.querySelector("#waveFill");

let peerConnection;
let dataChannel;
let audioInput;
let levelMonitor;
let remoteAudio;
let connectedAt;
let responseInProgress = false;
let translationFlushTimer;
let lastActiveAudioAt = 0;
let lastLoudAudioAt = 0;
let textTranslationBuffer = "";
let pendingTranslationText = "";
const waveSamples = Array.from({ length: 48 }, () => 0.02);

const state = {
  source: "",
  target: [],
  currentTarget: "",
  currentSource: "",
};

function setStatus(text, tone = "idle") {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
  meter.classList.toggle("active", tone === "live");
}

function drawWaveform(level = 0.02) {
  waveSamples.push(Math.min(1, Math.max(0.02, level)));
  waveSamples.shift();

  const width = 640;
  const center = 36;
  const points = waveSamples.map((sample, index) => {
    const x = (index / (waveSamples.length - 1)) * width;
    const phase = index * 0.74 + performance.now() / 180;
    const amplitude = 4 + sample * 28;
    const y = center + Math.sin(phase) * amplitude;
    return [x, y];
  });
  const line = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  wavePath?.setAttribute("d", line);
  waveFill?.setAttribute("d", `${line} L${width} 72 L0 72 Z`);
}

function log(message, data) {
  const stamp = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  const details = data ? ` ${JSON.stringify(data)}` : "";
  logEl.textContent = `[${stamp}] ${message}${details}\n${logEl.textContent}`.slice(0, 6000);
}

function showNotice(message, tone = "info") {
  noticeEl.textContent = message;
  noticeEl.dataset.tone = tone;
  noticeEl.hidden = !message;
}

function audioTrackSummary(stream) {
  return stream.getTracks().map((track) => ({
    kind: track.kind,
    label: track.label,
    readyState: track.readyState,
    enabled: track.enabled,
    muted: track.muted,
  }));
}

function startLevelMonitor(stream) {
  const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextImpl) return undefined;

  const audioContext = new AudioContextImpl();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  audioContext.resume?.();

  const samples = new Uint8Array(analyser.fftSize);
  let lastLog = 0;
  let bestPeak = 0;
  let frameId;

  const tick = (now) => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    let peak = 0;

    for (const sample of samples) {
      const value = Math.abs(sample - 128) / 128;
      sum += value * value;
      peak = Math.max(peak, value);
    }

    const rms = Math.sqrt(sum / samples.length);
    bestPeak = Math.max(bestPeak, peak);
    const active = rms > 0.015 || peak > 0.08;
    const loud = rms > 0.045 || peak > 0.18;
    if (active) lastActiveAudioAt = Date.now();
    if (loud) lastLoudAudioAt = Date.now();

    if (!lastLog || now - lastLog > 3000) {
      log("入力レベル", {
        rms: Number(rms.toFixed(4)),
        peak: Number(peak.toFixed(4)),
        bestPeak: Number(bestPeak.toFixed(4)),
      });
      lastLog = now;
    }

    drawWaveform(Math.max(rms * 7, peak * 2.4));
    frameId = requestAnimationFrame(tick);
  };

  frameId = requestAnimationFrame(tick);

  return {
    stop() {
      cancelAnimationFrame(frameId);
      audioContext.close?.();
    },
  };
}

function sendRealtimeEvent(event) {
  if (dataChannel?.readyState !== "open") return false;
  dataChannel.send(JSON.stringify(event));
  return true;
}

function scheduleTranslationFlush(delay = 700) {
  if (translationFlushTimer) window.clearTimeout(translationFlushTimer);
  translationFlushTimer = window.setTimeout(flushTranslationBuffer, delay);
}

function stopTranslationFlush() {
  if (translationFlushTimer) window.clearTimeout(translationFlushTimer);
  translationFlushTimer = undefined;
}

function render() {
  sourceText.textContent = formatTranscript(state.source, state.currentSource) || "英語音声を待っています。";
  renderTranslation();
  scrollToLatest(sourceText);
  scrollToLatest(targetText);
}

function formatTranscript(history, current) {
  const lines = history.trim().split("\n").filter(Boolean);
  if (current.trim()) lines.push(current.trim());
  return lines.join("\n");
}

function renderTranslation() {
  const items = state.target
    .filter((item) => item.text?.trim())
    .slice();

  targetText.replaceChildren();
  if (!items.length) {
    targetText.textContent = "ここに日本語の翻訳文字起こしが表示されます。";
    return;
  }

  for (const item of items) {
    const line = document.createElement("div");
    line.className = `captionLine speaker-${item.speaker || "unknown"}`;
    line.textContent = item.text;
    targetText.append(line);
  }
}

function scrollToLatest(element) {
  const scroll = () => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  };
  requestAnimationFrame(() => {
    scroll();
    requestAnimationFrame(scroll);
  });
}

function appendSentence(bucket, text) {
  const normalized = text?.trim();
  if (!normalized) return;
  if (bucket === "source") {
    const lines = state.source.trim().split("\n").filter(Boolean);
    if (lines.at(-1) === normalized) return;
    state.source += `${normalized}\n`;
    state.currentSource = "";
  }
  render();
}

function enqueueTranscriptForTranslation(transcript) {
  const normalized = transcript?.trim();
  if (!normalized) return;

  textTranslationBuffer = `${textTranslationBuffer} ${normalized}`.trim();
  const wordCount = textTranslationBuffer.split(/\s+/).filter(Boolean).length;
  const hasSentenceEnd = /[.!?]["')\]]?$/.test(normalized);

  if (hasSentenceEnd || wordCount >= 22) {
    flushTranslationBuffer();
    return;
  }

  scheduleTranslationFlush(1400);
}

function flushTranslationBuffer() {
  stopTranslationFlush();
  if (!textTranslationBuffer.trim() || responseInProgress) {
    if (textTranslationBuffer.trim()) scheduleTranslationFlush(900);
    return;
  }

  pendingTranslationText = textTranslationBuffer.trim();
  textTranslationBuffer = "";
  responseInProgress = true;
  sendRealtimeEvent({
    type: "response.create",
    event_id: `response_${Date.now()}`,
    response: {
      conversation: "none",
      output_modalities: ["text"],
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                ...buildTranslationRequestPayload(state, pendingTranslationText),
              }),
            },
          ],
        },
      ],
      instructions: buildTranslationInstructions(),
    },
  });
  log("テキスト翻訳送信", { words: pendingTranslationText.split(/\s+/).length });
}

function deleteConversationItem(itemId) {
  if (!itemId) return;
  sendRealtimeEvent({
    type: "conversation.item.delete",
    event_id: `delete_${Date.now()}_${itemId}`,
    item_id: itemId,
  });
}

function handleEvent(event) {
  switch (event.type) {
    case "session.created":
      log("セッション作成", { model: event.session?.model });
      break;
    case "session.updated":
      log("セッション更新");
      break;
    case "input_audio_buffer.speech_started":
      setStatus("聞き取り中", "live");
      state.currentSource = "";
      state.currentTarget = "";
      render();
      break;
    case "input_audio_buffer.speech_stopped":
      setStatus("翻訳中", "work");
      break;
    case "input_audio_buffer.committed":
      log("音声チャンク確定", { itemId: event.item_id });
      break;
    case "conversation.item.input_audio_transcription.delta":
      state.currentSource += event.delta || "";
      render();
      break;
    case "conversation.item.input_audio_transcription.completed":
      appendSentence("source", event.transcript || state.currentSource);
      enqueueTranscriptForTranslation(event.transcript || state.currentSource);
      deleteConversationItem(event.item_id);
      break;
    case "response.output_text.delta":
    case "response.output_audio_transcript.delta":
      state.currentTarget += event.delta || "";
      break;
    case "response.output_text.done":
    case "response.output_audio_transcript.done":
      applyTranslationResult(state, {
        ...parseTranslationResult(event.text || event.transcript || state.currentTarget),
        sourceEnglish: pendingTranslationText,
      });
      render();
      state.currentTarget = "";
      setStatus("接続中", "live");
      break;
    case "response.created":
      log("response.created");
      break;
    case "response.content_part.done":
      break;
    case "response.done":
      if (state.currentTarget.trim()) {
        applyTranslationResult(state, {
          ...parseTranslationResult(state.currentTarget),
          sourceEnglish: pendingTranslationText,
        });
        render();
        state.currentTarget = "";
      }
      responseInProgress = false;
      pendingTranslationText = "";
      if (textTranslationBuffer.trim()) scheduleTranslationFlush(500);
      setStatus("接続中", "live");
      break;
    case "error":
      setStatus("エラー", "error");
      log("API エラー", event.error || event);
      break;
    default:
      if (event.type?.includes("rate_limits")) return;
      log(event.type || "event");
  }
}

async function start() {
  startButton.disabled = true;
  inputMode.disabled = true;
  showNotice("");
  setStatus("入力確認中", "work");
  log("接続開始", { input: inputMode.value });

  try {
    audioInput = await createAudioInputStream({ mode: inputMode.value });
    log("入力取得", { tracks: audioTrackSummary(audioInput.stream) });
    levelMonitor = startLevelMonitor(audioInput.stream);
    audioInput.stream.getTracks().forEach((track) => {
      track.onended = () => {
        const message = `${track.kind} 入力が終了しました: ${track.label || "unknown"}`;
        showNotice(message, "warn");
        log("入力トラック終了", { kind: track.kind, label: track.label });
      };
    });

    peerConnection = new RTCPeerConnection();
    audioInput.stream.getAudioTracks().forEach((track) => peerConnection.addTrack(track, audioInput.stream));

    remoteAudio = new Audio();
    remoteAudio.autoplay = true;
    remoteAudio.muted = !audioToggle.checked;
    peerConnection.ontrack = ({ streams }) => {
      remoteAudio.srcObject = streams[0];
    };

    dataChannel = peerConnection.createDataChannel("oai-events");
    dataChannel.onopen = () => {
      connectedAt = Date.now();
      setStatus("接続中", "live");
      log("データチャンネル接続");
    };
    dataChannel.onmessage = ({ data }) => handleEvent(JSON.parse(data));
    dataChannel.onerror = () => setStatus("接続エラー", "error");

    peerConnection.onconnectionstatechange = () => {
      log("WebRTC 状態", { state: peerConnection.connectionState });
      if (peerConnection.connectionState === "failed") setStatus("接続失敗", "error");
      if (peerConnection.connectionState === "disconnected") setStatus("切断", "idle");
    };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const response = await fetch("/session", {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offer.sdp,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(payload.error || "Realtime session failed.");
    }

    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: await response.text(),
    });

    stopButton.disabled = false;
  } catch (error) {
    log("開始失敗", { message: error.message });
    showNotice(error.message, "error");
    setStatus("開始失敗", "error");
    stop({ preserveStatus: true });
  }
}

function stop({ preserveStatus = false } = {}) {
  stopTranslationFlush();
  dataChannel?.close();
  peerConnection?.close();
  levelMonitor?.stop();
  stopAudioInput(audioInput);
  remoteAudio?.pause();

  dataChannel = undefined;
  peerConnection = undefined;
  levelMonitor = undefined;
  audioInput = undefined;
  remoteAudio = undefined;
  responseInProgress = false;
  pendingTranslationText = "";
  textTranslationBuffer = "";
  lastActiveAudioAt = 0;
  lastLoudAudioAt = 0;
  startButton.disabled = false;
  stopButton.disabled = true;
  inputMode.disabled = false;

  const seconds = connectedAt ? Math.round((Date.now() - connectedAt) / 1000) : 0;
  if (!preserveStatus) setStatus("停止", "idle");
  if (seconds) log("停止", { seconds });
  connectedAt = undefined;
}

startButton.addEventListener("click", start);
stopButton.addEventListener("click", stop);
clearButton.addEventListener("click", () => {
  state.source = "";
  state.target = [];
  state.currentSource = "";
  state.currentTarget = "";
  render();
  log("表示をクリア");
});
audioToggle.addEventListener("change", () => {
  if (remoteAudio) remoteAudio.muted = !audioToggle.checked;
});

render();
