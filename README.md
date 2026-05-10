# Realtime English to Japanese Translation

英語の会話をマイクから取り込み、OpenAI Realtime API の `gpt-realtime-2` で日本語へリアルタイム文字起こしするローカル Web アプリです。

## 使い方

1. API キーを環境変数に設定します。

```powershell
$env:OPENAI_API_KEY="sk-proj-..."
```

2. サーバーを起動します。

```powershell
npm start
```

3. ブラウザで `http://localhost:3002` を開き、`録音開始` を押します。

## 入力ソース

画面上の `入力` から以下を選べます。

- `マイク`: 内蔵マイクまたは外部マイクの音声を翻訳します。
- `タブ/画面音声`: Chrome / Edge の共有ダイアログで選んだタブや画面の音声を翻訳します。YouTube や Web 会議の相手音声に使えます。
- `マイク + タブ音声`: マイクと共有タブ音声を Web Audio API で 1 本にミックスして翻訳します。

タブ音声を使う場合は、ブラウザの共有ダイアログで対象タブを選び、`タブの音声を共有` を有効にしてください。ブラウザや OS、DRM 保護されたコンテンツによっては音声共有が制限される場合があります。

## 構成

- `server.js`: ブラウザの SDP offer を受け取り、OpenAI の `/v1/realtime/calls` にサーバー側 API キーで中継します。
- `public/app.js`: WebRTC でマイク音声を送信し、DataChannel の `response.output_text.delta` などを日本語字幕として表示します。
- `public/styles.css`: 会話中に見やすい 2 ペイン UI です。

## 補足

OpenAI docs では、人間の発話を通訳する専用用途には `gpt-realtime-translate` と `/v1/realtime/translations` も案内されています。この実装はリクエストに合わせて `gpt-realtime-2` を使い、会話エージェントとして「英語を日本語へ翻訳だけする」指示を与えています。
