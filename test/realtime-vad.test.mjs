import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sessionConfig } from "../realtime-session.js";

test("sessionConfig uses OpenAI server VAD for continuous audio transcription chunking", () => {
  assert.deepEqual(sessionConfig.audio.input.turn_detection, {
    type: "server_vad",
    threshold: 0.4,
    prefix_padding_ms: 100,
    silence_duration_ms: 200,
    create_response: false,
    interrupt_response: false,
  });
});

test("client does not manually commit audio when OpenAI VAD is enabled", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.equal(app.includes('"input_audio_buffer.commit"'), false);
  assert.equal(app.includes("startChunkedTranslation"), false);
});
