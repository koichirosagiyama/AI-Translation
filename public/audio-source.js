const microphoneOptions = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

const displayOptions = {
  video: true,
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    systemAudio: "include",
    windowAudio: "system",
  },
};

function requireAudio(stream, label) {
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error(`${label} の音声トラックが見つかりません。共有時に「タブの音声を共有」を有効にしてください。`);
  }
}

function mixAudioStreams(streams, AudioContextImpl) {
  const audioContext = new AudioContextImpl();
  const destination = audioContext.createMediaStreamDestination();

  streams.forEach((stream) => {
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(destination);
  });

  return {
    stream: destination.stream,
    audioContext,
    cleanupStreams: streams,
  };
}

function captureAudioOnlyStream(stream, AudioContextImpl) {
  return mixAudioStreams([stream], AudioContextImpl);
}

export async function createAudioInputStream({
  mode,
  mediaDevices = navigator.mediaDevices,
  AudioContext = window.AudioContext || window.webkitAudioContext,
} = {}) {
  if (mode === "tab") {
    const tabStream = await mediaDevices.getDisplayMedia(displayOptions);
    requireAudio(tabStream, "タブ/画面共有");
    const audioOnly = captureAudioOnlyStream(tabStream, AudioContext);
    await audioOnly.audioContext.resume?.();
    return { ...audioOnly, cleanupStreams: [tabStream] };
  }

  if (mode === "mixed") {
    const [microphoneStream, tabStream] = await Promise.all([
      mediaDevices.getUserMedia(microphoneOptions),
      mediaDevices.getDisplayMedia(displayOptions),
    ]);
    requireAudio(microphoneStream, "マイク");
    requireAudio(tabStream, "タブ/画面共有");
    const mixed = mixAudioStreams([microphoneStream, tabStream], AudioContext);
    await mixed.audioContext.resume?.();
    return mixed;
  }

  const microphoneStream = await mediaDevices.getUserMedia(microphoneOptions);
  requireAudio(microphoneStream, "マイク");
  return { stream: microphoneStream, cleanupStreams: [microphoneStream] };
}

export function stopAudioInput(input) {
  input?.stream?.getTracks().forEach((track) => track.stop());
  input?.cleanupStreams?.forEach((stream) => {
    if (stream !== input.stream) stream.getTracks().forEach((track) => track.stop());
  });
  input?.audioContext?.close?.();
}
