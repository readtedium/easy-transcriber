import { WebSocket } from "ws";
import crypto from "crypto";
import { TtsProvider } from "./provider.js";

// ── 60db TTS provider (WebSocket transport) ───────────────────────────────────
// Docs: https://docs.60db.ai/websocket-api/tts
// Lifecycle: connect → wait for `connection_established` → `create_context` →
// `send_text` (one or more) → `flush_context` → stream `audio_chunk` frames →
// `close_context` → `context_closed`.
const SIXTYDB_WS_URL = "wss://api.60db.ai/ws/tts";
const DEFAULT_VOICE = "fbb75ed2-975a-40c7-9e06-38e30524a9a1";
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_ENCODING = "LINEAR16"; // raw 16-bit PCM, mono — concatenates cleanly
const MAX_TEXT_CHARS = 50000;        // 60db per-context cumulative limit
const SEND_CHUNK_CHARS = 2000;       // split long text into a few send_text calls

// Split text on whitespace into <=size pieces so very long transcripts stream
// as several send_text messages rather than one oversized payload.
function chunkText(text, size) {
  const out = [];
  let buf = "";
  for (const word of text.split(/(\s+)/)) {
    if (buf.length + word.length > size && buf) { out.push(buf); buf = ""; }
    buf += word;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

export class SixtyDbTtsProvider extends TtsProvider {
  get name() {
    return "60db";
  }

  bridge(clientWs, opts = {}) {
    const send = obj => {
      if (clientWs.readyState === clientWs.OPEN) clientWs.send(JSON.stringify(obj));
    };

    const apiKey = opts.apiKey;
    if (!apiKey) {
      send({ type: "error", message: "Missing 60db API key" });
      return clientWs.close();
    }

    const contextId = crypto.randomUUID();
    const sampleRate = opts.sampleRate || DEFAULT_SAMPLE_RATE;
    const encoding = opts.encoding || DEFAULT_ENCODING;
    const upstream = new WebSocket(`${SIXTYDB_WS_URL}?apiKey=${encodeURIComponent(apiKey)}`);

    let ready = false;       // context_created received → safe to send_text
    let closing = false;     // close_context already issued
    let pendingSpeak = null; // text received before the context was ready

    const speak = text => {
      const clipped = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
      if (text.length > MAX_TEXT_CHARS) {
        send({ type: "error", message: `Text truncated to ${MAX_TEXT_CHARS} characters (60db limit).` });
      }
      for (const chunk of chunkText(clipped, SEND_CHUNK_CHARS)) {
        upstream.send(JSON.stringify({ send_text: { context_id: contextId, text: chunk } }));
      }
      upstream.send(JSON.stringify({ flush_context: { context_id: contextId } }));
    };

    const closeContext = () => {
      if (closing || upstream.readyState !== WebSocket.OPEN) return;
      closing = true;
      upstream.send(JSON.stringify({ close_context: { context_id: contextId } }));
    };

    upstream.on("message", raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.connection_established) {
        upstream.send(JSON.stringify({
          create_context: {
            context_id: contextId,
            voice_id: opts.voiceId || DEFAULT_VOICE,
            audio_config: { audio_encoding: encoding, sample_rate_hertz: sampleRate },
            ...(opts.speed != null && { speed: opts.speed }),
            ...(opts.stability != null && { stability: opts.stability }),
            ...(opts.similarity != null && { similarity: opts.similarity }),
          },
        }));
      } else if (msg.context_created) {
        ready = true;
        send({ type: "ready", sampleRate, encoding });
        if (pendingSpeak != null) { speak(pendingSpeak); pendingSpeak = null; }
      } else if (msg.audio_chunk) {
        send({ type: "audio", audio: msg.audio_chunk.audioContent });
      } else if (msg.flush_completed) {
        send({ type: "flushed" });
        closeContext(); // one-shot: finalize the session once synthesis is delivered
      } else if (msg.context_closed) {
        send({ type: "done" });
        clientWs.close();
      } else if (msg.error) {
        send({ type: "error", message: msg.error.message || "60db synthesis error" });
      }
    });

    upstream.on("error", err =>
      send({ type: "error", message: err?.message || "60db connection error" }));
    upstream.on("close", () => {
      if (clientWs.readyState === clientWs.OPEN) clientWs.close();
    });

    clientWs.on("message", raw => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === "speak") {
        const text = (m.text || "").trim();
        if (!text) return;
        if (ready) speak(text); else pendingSpeak = text;
      } else if (m.type === "close") {
        closeContext();
      }
    });

    clientWs.on("close", () => { try { upstream.close(); } catch {} });
  }
}
