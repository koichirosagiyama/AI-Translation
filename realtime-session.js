export const sessionConfig = {
  type: "realtime",
  model: "gpt-realtime-2",
  output_modalities: ["text"],
  instructions: [
    "You are a live English-to-Japanese interpreter.",
    "Translate spoken English into natural Japanese in real time.",
    "Return only Japanese transcription text.",
    "Do not answer questions, add explanations, or describe your task.",
    "Keep numbers, names, dates, currencies, and technical terms accurate.",
  ].join(" "),
  audio: {
    input: {
      transcription: {
        model: "gpt-4o-transcribe",
        language: "en",
      },
      turn_detection: {
        type: "server_vad",
        threshold: 0.4,
        prefix_padding_ms: 100,
        silence_duration_ms: 200,
        create_response: false,
        interrupt_response: false,
      },
    },
  },
};
