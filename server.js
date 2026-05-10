import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { sessionConfig } from "./realtime-session.js";

const port = Number(process.env.PORT || 3002);
const publicDir = join(process.cwd(), "public");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function staticPath(urlPath) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const safePath = normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  return join(publicDir, safePath);
}

async function createRealtimeCall(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    sendJson(res, 500, {
      error: "OPENAI_API_KEY is not set. Create a .env or set the variable before starting the server.",
    });
    return;
  }

  const sdp = await readBody(req);
  if (!sdp.trim()) {
    sendJson(res, 400, { error: "Missing SDP offer body." });
    return;
  }

  const fd = new FormData();
  fd.set("sdp", sdp);
  fd.set("session", JSON.stringify(sessionConfig));

  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Safety-Identifier": "local-realtime-translation-demo",
    },
    body: fd,
  });

  const answer = await response.text();
  if (!response.ok) {
    sendJson(res, response.status, { error: answer });
    return;
  }

  res.writeHead(200, { "Content-Type": "application/sdp" });
  res.end(answer);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, model: sessionConfig.model });
      return;
    }

    if (req.method === "POST" && url.pathname === "/session") {
      await createRealtimeCall(req, res);
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed." });
      return;
    }

    const filePath = staticPath(url.pathname);
    if (!filePath.startsWith(publicDir)) {
      sendJson(res, 403, { error: "Forbidden." });
      return;
    }

    const file = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream" });
    res.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(res, 404, { error: "Not found." });
      return;
    }
    console.error(error);
    sendJson(res, 500, { error: "Unexpected server error." });
  }
});

server.listen(port, () => {
  console.log(`Realtime translation app: http://localhost:${port}`);
});
