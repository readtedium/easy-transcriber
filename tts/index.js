import { SixtyDbTtsProvider } from "./sixtydb.js";

// ── TTS provider registry ─────────────────────────────────────────────────────
// Register one instance per provider. Add a new engine by implementing
// TtsProvider (see ./provider.js) and adding it here — callers select by name.
const providers = {
  "60db": new SixtyDbTtsProvider(),
};

const DEFAULT_PROVIDER = "60db";

export function getTtsProvider(name) {
  return providers[name] || providers[DEFAULT_PROVIDER];
}

export function listTtsProviders() {
  return Object.keys(providers);
}
