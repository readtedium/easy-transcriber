// ── TTS provider interface ────────────────────────────────────────────────────
// Every text-to-speech provider implements this contract. The rest of the app
// only ever talks to a provider through `bridge()`, so providers are
// interchangeable and a new engine can be added by dropping in another subclass
// and registering it in ./index.js — no caller changes required.
//
// `bridge(clientWs, opts)` wires a browser WebSocket to the provider's streaming
// TTS. The browser↔server protocol is provider-agnostic:
//
//   browser → server : { type: "speak", text }   — synthesize this text
//                       { type: "close" }          — finish & end the session
//   server → browser : { type: "ready", sampleRate, encoding }
//                       { type: "audio", audio: <base64 PCM frame> }
//                       { type: "flushed" }        — all audio for a flush sent
//                       { type: "done" }           — session finished
//                       { type: "error", message }
//
// Audio frames are base64-encoded mono PCM (LINEAR16) at `sampleRate`, so the
// browser can concatenate and play them directly via the Web Audio API.
export class TtsProvider {
  /** Short identifier, e.g. "60db". */
  get name() {
    throw new Error("TtsProvider.name not implemented");
  }

  /**
   * Bridge a browser WebSocket to the provider's streaming synthesis.
   * @param {import("ws").WebSocket} clientWs  socket to the browser
   * @param {{
   *   apiKey?: string, voiceId?: string, speed?: number,
   *   stability?: number, similarity?: number,
   *   sampleRate?: number, encoding?: string,
   * }} opts
   */
  bridge(clientWs, opts) { // eslint-disable-line no-unused-vars
    throw new Error("TtsProvider.bridge not implemented");
  }
}
