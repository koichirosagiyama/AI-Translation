import test from "node:test";
import assert from "node:assert/strict";
import { createAudioInputStream, stopAudioInput } from "../public/audio-source.js";

function track(kind, label) {
  return {
    kind,
    label,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
}

function stream(tracks) {
  return {
    tracks,
    getTracks() {
      return tracks;
    },
    getAudioTracks() {
      return tracks.filter((item) => item.kind === "audio");
    },
    getVideoTracks() {
      return tracks.filter((item) => item.kind === "video");
    },
  };
}

function fakeAudioContext(outputTrack = track("audio", "mixed")) {
  return class {
    constructor() {
      this.destination = { stream: stream([outputTrack]) };
      this.sources = [];
    }

    createMediaStreamSource(input) {
      const source = {
        input,
        connectedTo: undefined,
        connect(destination) {
          this.connectedTo = destination;
        },
      };
      this.sources.push(source);
      return source;
    }

    createMediaStreamDestination() {
      return this.destination;
    }
  };
}

test("microphone mode requests only microphone audio", async () => {
  const microphone = stream([track("audio", "microphone")]);
  const calls = [];
  const mediaDevices = {
    async getUserMedia(options) {
      calls.push(["mic", options]);
      return microphone;
    },
  };

  const result = await createAudioInputStream({
    mode: "microphone",
    mediaDevices,
    AudioContext: fakeAudioContext(),
  });

  assert.equal(result.stream, microphone);
  assert.deepEqual(calls.map(([name]) => name), ["mic"]);
});

test("tab mode returns an audio-only stream while keeping display sharing alive", async () => {
  const video = track("video", "screen");
  const tabAudio = stream([track("audio", "tab"), video]);
  const capturedAudio = track("audio", "captured-tab");
  const calls = [];
  const mediaDevices = {
    async getDisplayMedia(options) {
      calls.push(["display", options]);
      return tabAudio;
    },
  };

  const result = await createAudioInputStream({
    mode: "tab",
    mediaDevices,
    AudioContext: fakeAudioContext(capturedAudio),
  });

  assert.deepEqual(result.stream.getAudioTracks(), [capturedAudio]);
  assert.deepEqual(result.stream.getVideoTracks(), []);
  assert.deepEqual(result.cleanupStreams, [tabAudio]);
  assert.equal(video.stopped, false);
  assert.deepEqual(calls.map(([name]) => name), ["display"]);

  stopAudioInput(result);

  assert.equal(video.stopped, true);
});

test("mixed mode combines microphone and tab audio into one stream", async () => {
  const microphone = stream([track("audio", "microphone")]);
  const tabAudio = stream([track("audio", "tab"), track("video", "screen")]);
  const mixedTrack = track("audio", "mixed");
  const mediaDevices = {
    async getUserMedia() {
      return microphone;
    },
    async getDisplayMedia() {
      return tabAudio;
    },
  };

  const result = await createAudioInputStream({
    mode: "mixed",
    mediaDevices,
    AudioContext: fakeAudioContext(mixedTrack),
  });

  assert.deepEqual(result.stream.getAudioTracks(), [mixedTrack]);
  assert.deepEqual(result.cleanupStreams, [microphone, tabAudio]);
});
