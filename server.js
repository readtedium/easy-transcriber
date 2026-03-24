import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { createClient } from "@deepgram/sdk";
import multer from "multer";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, "history.json");
const MEDIA_DIR = path.join(__dirname, "media");

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

const app = express();
const server = createServer({ maxHeaderSize: 32768 }, app);
const wss = new WebSocketServer({ server, path: "/live" });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/media", express.static(MEDIA_DIR));

const upload = multer({ dest: "uploads/", limits: { fileSize: 2048 * 1024 * 1024 } });
const VIDEO_TYPES = new Set(["video/mp4","video/quicktime","video/x-msvideo","video/webm","video/mkv","video/x-matroska"]);

// ── Helpers ───────────────────────────────────────────────────────────────────
function getYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("?")[0];
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
  } catch {}
  return null;
}

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); }
  catch { return []; }
}
function saveHistory(h) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2));
}
function mediaUrlForId(id) {
  for (const ext of ["mp3", "webm"]) {
    if (fs.existsSync(path.join(MEDIA_DIR, `${id}.${ext}`))) return `/media/${id}.${ext}`;
  }
  return null;
}

// ── DeepSeek topic extraction ─────────────────────────────────────────────────
async function callDeepSeek(prompt) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-chat", max_tokens: 2048, temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await resp.json();
  let text = data.choices?.[0]?.message?.content?.trim() || "[]";
  // Strip markdown code fences if present
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // Extract just the JSON array if there's surrounding text
  const match = text.match(/\[[\s\S]*\]/);
  if (match) text = match[0];
  return JSON.parse(text);
}

async function extractTopics(utterances) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  console.log("extractTopics — utterances:", utterances?.length, "key:", !!apiKey);
  if (!apiKey || !utterances?.length) return [];

  const fmtT = s => `${String(Math.floor(s/60)).padStart(2,"0")}:${String(Math.floor(s%60)).padStart(2,"0")}`;
  const toLines = utts => utts.map(u => `[${Math.round(u.start)}s] Speaker ${(u.speaker??0)+1}: ${u.transcript}`).join("\n");

  const chunkPrompt = chunk => `You are analyzing part of a transcript. Identify up to 5 genuinely interesting or notable moments — specific claims, surprising facts, key decisions, memorable exchanges. Skip small talk and filler.

Timestamps are in seconds from the start of the recording.

Return ONLY a JSON array with objects: { "start": seconds_as_number, "end": seconds_as_number, "label": "punchy 6-10 word description" }

Transcript segment:
${toLines(chunk)}`;

  const curatePrompt = candidates => `You are curating the most interesting moments from a long transcript. Below are candidate moments extracted from different segments. Select the 10-20 most genuinely interesting, diverse, and notable ones. Remove duplicates or near-duplicates. Keep the best spread across the full timeline.

Return ONLY a JSON array with the selected objects: { "start": seconds, "end": seconds, "label": "description" }

Candidates:
${JSON.stringify(candidates, null, 2)}`;

  try {
    // Chunk into ~5 minute windows
    const CHUNK_SECS = 300;
    const maxTime = utterances[utterances.length - 1].end || utterances[utterances.length - 1].start;
    const chunks = [];
    for (let t = 0; t < maxTime; t += CHUNK_SECS) {
      const chunk = utterances.filter(u => u.start >= t && u.start < t + CHUNK_SECS);
      if (chunk.length) chunks.push(chunk);
    }

    console.log(`Processing ${chunks.length} chunks...`);
    const allCandidates = [];
    for (const chunk of chunks) {
      try {
        const results = await callDeepSeek(chunkPrompt(chunk));
        if (Array.isArray(results)) allCandidates.push(...results);
      } catch (err) {
        console.error("Chunk failed:", err.message);
      }
    }

    console.log(`Got ${allCandidates.length} candidates, curating...`);
    if (allCandidates.length <= 10) return allCandidates;

    const curated = await callDeepSeek(curatePrompt(allCandidates));
    console.log(`Final topics: ${curated?.length}`);
    return Array.isArray(curated) ? curated : allCandidates;
  } catch (err) {
    console.error("extractTopics failed:", err.message);
    return [];
  }
}

// ── /retopics — regenerate topics for a history entry ────────────────────────
app.post("/retopics/:id", async (req, res) => {
  const entry = loadHistory().find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Entry not found" });
  const utterances = entry.result?.results?.utterances || [];
  const topics = await extractTopics(utterances);
  const h = loadHistory().map(e => e.id === req.params.id ? { ...e, topics } : e);
  saveHistory(h);
  res.json({ topics });
});

// ── History endpoints ─────────────────────────────────────────────────────────
app.get("/history", (req, res) => {
  const h = loadHistory().map(e => ({ ...e, mediaUrl: mediaUrlForId(e.id) }));
  res.json(h);
});
app.patch("/history/:id/speakers", (req, res) => {
  const { speakerNames } = req.body;
  const h = loadHistory().map(e =>
    e.id === req.params.id ? { ...e, speakerNames: speakerNames === null ? {} : { ...(e.speakerNames || {}), ...speakerNames } } : e
  );
  saveHistory(h);
  res.json({ ok: true });
});

app.delete("/history/:id", (req, res) => {
  const id = req.params.id;
  saveHistory(loadHistory().filter(e => e.id !== id));
  for (const ext of ["mp3", "webm"]) {
    const p = path.join(MEDIA_DIR, `${id}.${ext}`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  res.json({ ok: true });
});
app.delete("/history", (req, res) => {
  for (const f of fs.readdirSync(MEDIA_DIR)) fs.unlinkSync(path.join(MEDIA_DIR, f));
  saveHistory([]);
  res.json({ ok: true });
});

// ── /save-live ────────────────────────────────────────────────────────────────
const uploadLive = multer({ dest: "uploads/" });
app.post("/save-live", uploadLive.fields([{ name: "mic" }, { name: "sys" }]), async (req, res) => {
  const transcript = req.body.transcript;
  const duration = parseFloat(req.body.duration || "0");
  if (!transcript) return res.status(400).json({ error: "No transcript" });

  const id = Date.now().toString();
  const micPath = req.files?.mic?.[0]?.path;
  const sysPath = req.files?.sys?.[0]?.path;
  const outPath = path.join(MEDIA_DIR, `${id}.webm`);
  console.log("save-live: mic:", micPath, "sys:", sysPath, "out:", outPath);
  console.log("save-live: mic size:", micPath ? fs.statSync(micPath).size : "none");
  console.log("save-live: transcript length:", transcript?.length);

  try {
    if (micPath && sysPath) {
      await execFileAsync("ffmpeg", [
        "-i", micPath, "-i", sysPath,
        "-filter_complex", "amix=inputs=2:duration=longest",
        "-c:a", "libopus", "-y", outPath,
      ]);
    } else if (micPath) {
      // Always remux through ffmpeg — raw webm chunks need a proper container
      await execFileAsync("ffmpeg", [
        "-i", micPath,
        "-c:a", "copy",
        "-y", outPath,
      ]);
    }
  } catch (err) {
    console.error("Audio mix failed:", err.message);
    if (micPath && fs.existsSync(micPath)) fs.copyFileSync(micPath, outPath);
  } finally {
    if (micPath && fs.existsSync(micPath)) fs.unlinkSync(micPath);
    if (sysPath && fs.existsSync(sysPath)) fs.unlinkSync(sysPath);
  }

  let utterances = [];
  try { utterances = JSON.parse(req.body.utterances || "[]"); } catch {}

  const entry = {
    id,
    filename: `Live recording — ${new Date().toLocaleString()}`,
    createdAt: new Date().toISOString(),
    ytId: null, sourceUrl: null,
    result: {
      results: {
        channels: [{ alternatives: [{ transcript, paragraphs: utterances.length ? null : [{ sentences: [{ text: transcript, start: 0, end: duration }], speaker: 0 }] }] }],
        utterances, summary: null,
      }
    },
  };
  const h = loadHistory(); h.unshift(entry); saveHistory(h);
  res.json({ id, mediaUrl: mediaUrlForId(id) });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseKeyterms(val) {
  return (val || "").split(",").map(k => k.trim()).filter(Boolean);
}

// ── Audio extraction ──────────────────────────────────────────────────────────
async function extractAudio(inputPath, destPath) {
  await execFileAsync("ffmpeg", [
    "-i", inputPath, "-vn", "-ac", "2", "-ar", "44100", "-b:a", "192k", "-f", "mp3", "-y", destPath,
  ]);
}

// ── yt-dlp download ───────────────────────────────────────────────────────────
async function downloadFromUrl(url, outputDir) {
  const outputTemplate = path.join(outputDir, "%(id)s.%(ext)s");
  const { stdout: infoOut } = await execFileAsync("yt-dlp", ["--print", "%(title)s", "--no-playlist", url]);
  const title = infoOut.trim() || url;
  const { stdout } = await execFileAsync("yt-dlp", [
    "-x", "--audio-format", "mp3", "--audio-quality", "0",
    "--postprocessor-args", "ffmpeg:-ar 44100 -ac 2 -b:a 192k",
    "--no-playlist", "--print", "after_move:filepath", "-o", outputTemplate, url,
  ]);
  return { filePath: stdout.trim(), title };
}

// ── /transcribe-url ───────────────────────────────────────────────────────────
app.post("/transcribe-url", async (req, res) => {
  const { url, keyterms: keytermStr } = req.body;
  if (!url) return res.status(400).json({ error: "No URL provided" });
  const apiKey = req.headers["x-deepgram-key"] || process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return res.status(401).json({ error: "Missing API key" });
  const keyterms = parseKeyterms(keytermStr);
  let filePath = null;
  try {
    const { filePath: fp, title } = await downloadFromUrl(url, path.join(__dirname, "uploads"));
    filePath = fp;
    const dg = createClient(apiKey);
    const { result, error } = await dg.listen.prerecorded.transcribeFile(fs.readFileSync(filePath), {
      model: "nova-3", smart_format: true, diarize: true,
      paragraphs: true, summarize: "v2", punctuate: true, utterances: true,
      ...(keyterms.length && { keyterm: keyterms }),
    });
    if (error) return res.status(500).json({ error: error.message });

    const topics = await extractTopics(result.results?.utterances || []);
    const ytId = getYouTubeId(url) || null;
    const entry = { id: Date.now().toString(), filename: title, createdAt: new Date().toISOString(), ytId, sourceUrl: url, result, topics };
    const h = loadHistory(); h.unshift(entry); saveHistory(h);
    res.json({ ...result, _historyId: entry.id, _title: title, _ytId: ytId, _topics: topics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});

// ── /transcribe (file upload) ─────────────────────────────────────────────────
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const apiKey = req.headers["x-deepgram-key"] || process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return res.status(401).json({ error: "Missing API key" });
  const keyterms = parseKeyterms(req.body.keyterms);
  const id = Date.now().toString();
  const savedAudioPath = path.join(MEDIA_DIR, `${id}.mp3`);
  try {
    await extractAudio(req.file.path, savedAudioPath);
    const dg = createClient(apiKey);
    const { result, error } = await dg.listen.prerecorded.transcribeFile(fs.readFileSync(savedAudioPath), {
      model: "nova-3", smart_format: true, diarize: true,
      paragraphs: true, summarize: "v2", punctuate: true, utterances: true,
      ...(keyterms.length && { keyterm: keyterms }),
    });
    if (error) return res.status(500).json({ error: error.message });

    const topics = await extractTopics(result.results?.utterances || []);
    const entry = { id, filename: req.file.originalname, createdAt: new Date().toISOString(), ytId: null, sourceUrl: null, result, topics };
    const h = loadHistory(); h.unshift(entry); saveHistory(h);
    res.json({ ...result, _historyId: id, mediaUrl: `/media/${id}.mp3`, _topics: topics });
  } catch (err) {
    if (fs.existsSync(savedAudioPath)) fs.unlinkSync(savedAudioPath);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

// ── Live transcription ────────────────────────────────────────────────────────
wss.on("connection", (clientWs, req) => {
  const qIndex = req.url.indexOf("?");
  const params = new URLSearchParams(qIndex >= 0 ? req.url.slice(qIndex + 1) : "");
  const apiKey = params.get("key") || process.env.DEEPGRAM_API_KEY;
  const dual = params.get("dual") === "1";

  if (!apiKey) {
    clientWs.send(JSON.stringify({ type: "error", message: "Missing API key" }));
    return clientWs.close();
  }

  const send = obj => {
    if (clientWs.readyState === clientWs.OPEN) clientWs.send(JSON.stringify(obj));
  };

  const dg = createClient(apiKey);
  const keyterms = params.getAll("keyterm").filter(Boolean);
  const dgOptions = {
    model: "nova-3", smart_format: true, diarize: true, punctuate: true,
    interim_results: true, utterance_end_ms: 1000, vad_events: true,
    ...(keyterms.length && { keyterm: keyterms }),
  };

  (async () => {
    try {
      const source = dual ? (params.get("source") || "mic") : "mic";
      const conn = await dg.listen.live(dgOptions);
      conn.on("open", () => send({ type: "connected" }));
      conn.on("close", () => send({ type: "closed" }));
      conn.on("Results", data => send({ type: "transcript", data, source }));
      conn.on("error", err => send({ type: "error", message: err?.message || String(err) }));
      clientWs.on("message", msg => { if (conn.getReadyState() === 1) conn.send(msg); });
      clientWs.on("close", () => { try { conn.finish(); } catch {} });
    } catch (err) {
      console.error("Failed to open Deepgram connection:", err);
      send({ type: "error", message: err?.message || "Failed to connect to Deepgram" });
      clientWs.close();
    }
  })();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Transcriber running on http://localhost:${PORT}`));