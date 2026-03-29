import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { createClient } from "@deepgram/sdk";
import Database from "better-sqlite3";
import multer from "multer";
import cors from "cors";
import session from "express-session";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = path.join(__dirname, "media");

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

// ── Check external tools ───────────────────────────────────────────────────────
for (const tool of ["ffmpeg", "yt-dlp"]) {
  execFile(tool, ["--version"], err => {
    if (err?.code === "ENOENT") console.warn(`Warning: ${tool} not found — install it or some features will not work.`);
  });
}

// ── Database ──────────────────────────────────────────────────────────────────
const DB_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, "transcripts.db"));
db.exec(`CREATE TABLE IF NOT EXISTS history (
  id           TEXT PRIMARY KEY,
  filename     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  yt_id        TEXT,
  source_url   TEXT,
  result       TEXT NOT NULL,
  topics       TEXT,
  speaker_names TEXT,
  has_video    INTEGER DEFAULT 0
)`);
try { db.exec(`ALTER TABLE history ADD COLUMN has_video INTEGER DEFAULT 0`); } catch {}

function rowToEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    createdAt: row.created_at,
    ytId: row.yt_id,
    sourceUrl: row.source_url,
    result: JSON.parse(row.result),
    topics: row.topics ? JSON.parse(row.topics) : null,
    speakerNames: row.speaker_names ? JSON.parse(row.speaker_names) : {},
    hasVideo: row.has_video === 1,
  };
}

const stmts = {
  getAll:    db.prepare("SELECT * FROM history ORDER BY created_at DESC"),
  getById:   db.prepare("SELECT * FROM history WHERE id = ?"),
  insert:    db.prepare(`INSERT INTO history (id,filename,created_at,yt_id,source_url,result,topics,speaker_names,has_video)
                         VALUES (@id,@filename,@created_at,@yt_id,@source_url,@result,@topics,@speaker_names,@has_video)`),
  deleteOne: db.prepare("DELETE FROM history WHERE id = ?"),
  deleteAll: db.prepare("DELETE FROM history"),
  setTopics: db.prepare("UPDATE history SET topics = ? WHERE id = ?"),
  getSpeakerNames: db.prepare("SELECT speaker_names FROM history WHERE id = ?"),
  setSpeakerNames: db.prepare("UPDATE history SET speaker_names = ? WHERE id = ?"),
  updateFilename:  db.prepare("UPDATE history SET filename = ? WHERE id = ?"),
};

function dbGetAll()    { return stmts.getAll.all().map(rowToEntry); }
function dbGetById(id) { return rowToEntry(stmts.getById.get(id)); }
function dbInsert(entry) {
  stmts.insert.run({
    id: entry.id, filename: entry.filename, created_at: entry.createdAt,
    yt_id: entry.ytId ?? null, source_url: entry.sourceUrl ?? null,
    result: JSON.stringify(entry.result),
    topics: entry.topics ? JSON.stringify(entry.topics) : null,
    speaker_names: entry.speakerNames ? JSON.stringify(entry.speakerNames) : null,
    has_video: entry.hasVideo ? 1 : 0,
  });
}
function dbDeleteById(id) { stmts.deleteOne.run(id); }
function dbDeleteAll()    { stmts.deleteAll.run(); }
function dbUpdateTopics(id, topics) {
  stmts.setTopics.run(topics ? JSON.stringify(topics) : null, id);
}
function dbUpdateSpeakerNames(id, speakerNames) {
  if (speakerNames === null) {
    stmts.setSpeakerNames.run(null, id);
  } else {
    const row = stmts.getSpeakerNames.get(id);
    const existing = row?.speaker_names ? JSON.parse(row.speaker_names) : {};
    stmts.setSpeakerNames.run(JSON.stringify({ ...existing, ...speakerNames }), id);
  }
}

// ── Migrate from history.json if present ─────────────────────────────────────
(function migrateFromJson() {
  const jsonPath = path.join(__dirname, "history.json");
  if (!fs.existsSync(jsonPath)) return;
  try {
    const entries = JSON.parse(fs.readFileSync(jsonPath, "utf8") || "[]");
    if (!Array.isArray(entries)) return;
    db.transaction(() => { for (const e of entries) { try { dbInsert(e); } catch {} } })();
    fs.renameSync(jsonPath, jsonPath + ".migrated");
    if (entries.length) console.log(`Migrated ${entries.length} entries from history.json`);
  } catch (err) {
    console.error("history.json migration failed:", err.message);
  }
})();

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Easy Transcriber</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #f9f9f8; --surface: #ffffff; --border: rgba(0,0,0,0.1);
      --text: #1a1a18; --accent: #4a3fc7; --accent-light: #eeecfe;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1a1a18; --surface: #242422; --border: rgba(255,255,255,0.12);
        --text: #f0efe8; --accent: #8f88e8; --accent-light: #26215c;
      }
    }
    body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text);
           display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: var(--surface); border-radius: 12px; padding: 2rem; width: 100%; max-width: 340px;
            box-shadow: 0 2px 16px rgba(0,0,0,.08); }
    h1 { font-size: 1.1rem; font-weight: 500; margin-bottom: 1.5rem; }
    input[type=password] { width: 100%; padding: .6rem .8rem; border: 0.5px solid var(--border);
                           border-radius: 8px; font-size: 15px; margin-bottom: 1rem; outline: none;
                           background: var(--bg); color: var(--text); }
    input[type=password]:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-light); }
    button { width: 100%; padding: .65rem; background: var(--accent); color: #fff; border: none;
             border-radius: 8px; font-size: 15px; cursor: pointer; }
    button:hover { opacity: 0.9; }
    .error { color: #f87171; font-size: 13px; margin-top: .75rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Easy Transcriber</h1>
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password"/>
      <button type="submit">Log in</button>
      {{ERROR}}
    </form>
  </div>
</body>
</html>`;

const app = express();
const server = createServer({ maxHeaderSize: 32768 }, app);
server.requestTimeout = 0; // disable 5-min default; long Moonshine jobs need unlimited time
const wss = new WebSocketServer({ noServer: true });

app.use(cors());
app.use(express.json());

// ── Auth ──────────────────────────────────────────────────────────────────────
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000 },
});
app.use(sessionMiddleware);

function requireAuth(req, res, next) {
  if (!process.env.LOGIN_PASSWORD) return next();
  if (req.session?.authed) return next();
  if (req.path === "/login" || req.path === "/logout" || req.path === "/auth") return next();
  // API calls get 401; browser navigations get redirected to login
  if (req.method !== "GET" || req.path.startsWith("/history") || req.path.startsWith("/media") || req.path.startsWith("/retopics")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}
app.use(requireAuth);

if (process.env.LOGIN_PASSWORD) {
  console.log("Password protection enabled.");
} else {
  console.log("Warning: No LOGIN_PASSWORD set — running without authentication.");
}

// Static files — served only after auth check
app.use(express.static(path.join(__dirname, "public")));
app.use("/media", express.static(MEDIA_DIR));

// ── Login / logout routes ─────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, skipSuccessfulRequests: true,
  standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => res.status(429).send(LOGIN_HTML.replace("{{ERROR}}", '<p class="error">Too many attempts. Try again in 15 minutes.</p>')),
});

app.get("/auth", (req, res) => res.json({ enabled: !!process.env.LOGIN_PASSWORD, hasDeepgramKey: !!process.env.DEEPGRAM_API_KEY }));

app.get("/login", (req, res) => {
  if (!process.env.LOGIN_PASSWORD || req.session?.authed) return res.redirect("/");
  res.send(LOGIN_HTML.replace("{{ERROR}}", ""));
});
app.post("/login", express.urlencoded({ extended: false }), loginLimiter, (req, res) => {
  const pwd = process.env.LOGIN_PASSWORD;
  if (!pwd) return res.redirect("/");
  const supplied = Buffer.from(req.body.password || "");
  const expected = Buffer.from(pwd);
  const ok = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  if (ok) {
    req.session.authed = true;
    const next = req.query.next || "/";
    return res.redirect(/^\/(?!\/)/.test(next) ? next : "/");
  }
  res.status(401).send(LOGIN_HTML.replace("{{ERROR}}", '<p class="error">Incorrect password.</p>'));
});
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let resp;
  try {
    resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
      signal: controller.signal,
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat", max_tokens: 2048, temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } finally {
    clearTimeout(timer);
  }
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
  const entry = dbGetById(req.params.id);
  if (!entry) return res.status(404).json({ error: "Entry not found" });
  const utterances = entry.result?.results?.utterances || [];
  const topics = await extractTopics(utterances);
  dbUpdateTopics(req.params.id, topics);
  res.json({ topics });
});

// ── History endpoints ─────────────────────────────────────────────────────────
app.get("/history", (req, res) => {
  res.json(dbGetAll().map(e => ({ ...e, mediaUrl: mediaUrlForId(e.id) })));
});
app.patch("/history/:id/filename", express.json(), (req, res) => {
  const { filename } = req.body;
  if (!filename?.trim()) return res.status(400).json({ error: "empty" });
  stmts.updateFilename.run(filename.trim(), req.params.id);
  res.json({ ok: true });
});
app.patch("/history/:id/speakers", (req, res) => {
  dbUpdateSpeakerNames(req.params.id, req.body.speakerNames);
  res.json({ ok: true });
});
app.delete("/history/:id", (req, res) => {
  const { id } = req.params;
  dbDeleteById(id);
  for (const ext of ["mp3", "webm"]) {
    const p = path.join(MEDIA_DIR, `${id}.${ext}`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  res.json({ ok: true });
});
app.delete("/history", (req, res) => {
  for (const f of fs.readdirSync(MEDIA_DIR)) fs.unlinkSync(path.join(MEDIA_DIR, f));
  dbDeleteAll();
  res.json({ ok: true });
});

// ── /save-live ────────────────────────────────────────────────────────────────
const uploadLive = multer({ dest: "uploads/", limits: { fieldSize: 50 * 1024 * 1024 } });
app.post("/save-live", uploadLive.fields([{ name: "mic" }, { name: "sys" }, { name: "video" }]), async (req, res) => {
  const transcript = req.body.transcript;
  const duration = parseFloat(req.body.duration || "0");
  if (!transcript) return res.status(400).json({ error: "No transcript" });

  const id = Date.now().toString();
  const micPath = req.files?.mic?.[0]?.path;
  const sysPath = req.files?.sys?.[0]?.path;
  const videoPath = req.files?.video?.[0]?.path;
  const compress = req.body.compress !== "0";
  const outPath = path.join(MEDIA_DIR, `${id}.webm`);
  console.log("save-live: mic:", micPath, "sys:", sysPath, "video:", videoPath, "out:", outPath);
  console.log("save-live: mic size:", micPath ? fs.statSync(micPath).size : "none");
  console.log("save-live: transcript length:", transcript?.length);

  try {
    if (videoPath) {
      // Build input list and track indices
      const args = [];
      let idx = 0, micIdx = -1, sysIdx = -1;
      if (micPath) { args.push("-i", micPath); micIdx = idx++; }
      if (sysPath) { args.push("-i", sysPath); sysIdx = idx++; }
      args.push("-i", videoPath);
      const vidIdx = idx;

      if (micIdx >= 0 && sysIdx >= 0) {
        args.push("-filter_complex", `[${micIdx}:a]aformat=channel_layouts=stereo[a0];[${sysIdx}:a]aformat=channel_layouts=stereo[a1];[a0][a1]amix=inputs=2:duration=longest[aout]`);
        args.push("-map", `${vidIdx}:v:0`, "-map", "[aout]");
      } else if (micIdx >= 0) {
        args.push("-map", `${vidIdx}:v:0`, "-map", `${micIdx}:a:0`);
      } else {
        args.push("-map", `${vidIdx}:v:0`);
      }

      if (compress) args.push("-vf", "scale=-2:480");
      args.push("-c:v", "libvpx", "-crf", "10", "-b:v", "1M", "-c:a", "libopus", "-y", outPath);
      await execFileAsync("ffmpeg", args);
    } else if (micPath && sysPath) {
      await execFileAsync("ffmpeg", [
        "-i", micPath, "-i", sysPath,
        "-filter_complex", "[0:a]aformat=channel_layouts=stereo[a0];[1:a]aformat=channel_layouts=stereo[a1];[a0][a1]amix=inputs=2:duration=longest[aout]",
        "-map", "[aout]", "-c:a", "libopus", "-y", outPath,
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
    console.error("Audio/video mix failed:", err.message);
    if (!videoPath && micPath && fs.existsSync(micPath)) fs.copyFileSync(micPath, outPath);
  } finally {
    if (micPath && fs.existsSync(micPath)) fs.unlinkSync(micPath);
    if (sysPath && fs.existsSync(sysPath)) fs.unlinkSync(sysPath);
    if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  }

  let utterances = [];
  try { utterances = JSON.parse(req.body.utterances || "[]"); } catch {}

  const entry = {
    id,
    filename: `Live recording — ${new Date().toLocaleString()}`,
    createdAt: new Date().toISOString(),
    ytId: null, sourceUrl: null,
    hasVideo: !!videoPath,
    result: {
      results: {
        channels: [{ alternatives: [{ transcript, paragraphs: utterances.length ? null : [{ sentences: [{ text: transcript, start: 0, end: duration }], speaker: 0 }] }] }],
        utterances, summary: null,
      }
    },
  };
  dbInsert(entry);
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
  const backend = req.body.backend === "moonshine" && moonshineAvailable ? "moonshine" : "deepgram";
  const apiKey = req.headers["x-deepgram-key"] || process.env.DEEPGRAM_API_KEY;
  if (backend === "deepgram" && !apiKey) return res.status(401).json({ error: "Missing API key" });
  const keyterms = parseKeyterms(keytermStr);
  let filePath = null;
  try {
    const { filePath: fp, title } = await downloadFromUrl(url, path.join(__dirname, "uploads"));
    filePath = fp;
    let result;
    if (backend === "moonshine") {
      result = await transcribeWithMoonshine(filePath);
    } else {
      const dg = createClient(apiKey);
      const { result: dgResult, error } = await dg.listen.prerecorded.transcribeFile(fs.readFileSync(filePath), {
        model: "nova-3", smart_format: true, diarize: true,
        paragraphs: true, summarize: "v2", punctuate: true, utterances: true,
        ...(keyterms.length && { keyterm: keyterms }),
      });
      if (error) return res.status(500).json({ error: error.message });
      result = dgResult;
    }

    const topics = await extractTopics(result.results?.utterances || []);
    const ytId = getYouTubeId(url) || null;
    const entry = { id: Date.now().toString(), filename: title, createdAt: new Date().toISOString(), ytId, sourceUrl: url, result, topics };
    dbInsert(entry);
    res.json({ ...result, _historyId: entry.id, _title: title, _ytId: ytId, _topics: topics });
  } catch (err) {
    const msg = err.code === "ENOENT"
      ? "yt-dlp is not installed. Install it to use URL transcription."
      : err.message;
    res.status(err.code === "ENOENT" ? 503 : 500).json({ error: msg });
  } finally {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});

// ── /transcribe (file upload) ─────────────────────────────────────────────────
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const backend = req.body.backend === "moonshine" && moonshineAvailable ? "moonshine" : "deepgram";
  const apiKey = req.headers["x-deepgram-key"] || process.env.DEEPGRAM_API_KEY;
  if (backend === "deepgram" && !apiKey) return res.status(401).json({ error: "Missing API key" });
  const keyterms = parseKeyterms(req.body.keyterms);
  const id = Date.now().toString();
  const savedAudioPath = path.join(MEDIA_DIR, `${id}.mp3`);

  // ── Moonshine: SSE streaming path ──────────────────────────────────────────
  if (backend === "moonshine") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    const sse = obj => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    const chunkDir = path.join(__dirname, "uploads", `chunks-${id}`);
    let aborted = false;
    req.on("close", () => { aborted = true; });
    try {
      await extractAudio(req.file.path, savedAudioPath);
      const chunkFiles = await splitAudioChunks(savedAudioPath, chunkDir);
      const allLines = [];
      let offsetSec = 0;
      for (let i = 0; i < chunkFiles.length; i++) {
        if (aborted) break;
        const chunkPath = path.join(chunkDir, chunkFiles[i]);
        const { lines = [] } = await transcribeChunkWithMoonshine(chunkPath, offsetSec);
        allLines.push(...lines);
        offsetSec += await getAudioDuration(chunkPath);
        sse({ type: "chunk", lines, current: i + 1, total: chunkFiles.length });
        fs.unlinkSync(chunkPath);
      }
      if (!aborted) {
        const duration = allLines.length ? allLines[allLines.length - 1].end : 0;
        const result = buildMoonshineResult(allLines, duration);
        const topics = await extractTopics(result.results?.utterances || []);
        const entry = { id, filename: req.file.originalname, createdAt: new Date().toISOString(), ytId: null, sourceUrl: null, result, topics };
        dbInsert(entry);
        sse({ type: "done", ...result, _historyId: id, _filename: req.file.originalname, mediaUrl: `/media/${id}.mp3`, _topics: topics });
      }
    } catch (err) {
      sse({ type: "error", error: err.message });
      if (fs.existsSync(savedAudioPath)) fs.unlinkSync(savedAudioPath);
    } finally {
      res.end();
      if (fs.existsSync(chunkDir)) fs.rmSync(chunkDir, { recursive: true, force: true });
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
    return;
  }

  // ── Deepgram: standard JSON path ───────────────────────────────────────────
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
    dbInsert(entry);
    res.json({ ...result, _historyId: id, _filename: req.file.originalname, mediaUrl: `/media/${id}.mp3`, _topics: topics });
  } catch (err) {
    if (fs.existsSync(savedAudioPath)) fs.unlinkSync(savedAudioPath);
    res.status(500).json({ error: err.message });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
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
      let dgReady = false;
      const pending = [];
      conn.on("open", () => {
        dgReady = true;
        pending.splice(0).forEach(msg => conn.send(msg));
        send({ type: "connected" });
      });
      conn.on("close", () => send({ type: "closed" }));
      conn.on("Results", data => send({ type: "transcript", data, source }));
      conn.on("error", err => send({ type: "error", message: err?.message || String(err) }));
      clientWs.on("message", msg => { if (dgReady) conn.send(msg); else pending.push(msg); });
      clientWs.on("close", () => { try { conn.finish(); } catch {} });
    } catch (err) {
      console.error("Failed to open Deepgram connection:", err);
      send({ type: "error", message: err?.message || "Failed to connect to Deepgram" });
      clientWs.close();
    }
  })();
});

// ── WebSocket upgrade (with auth) ─────────────────────────────────────────────
server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/live")) { socket.destroy(); return; }
  sessionMiddleware(req, { end: () => {}, getHeader: () => {}, setHeader: () => {} }, () => {
    if (process.env.LOGIN_PASSWORD && !req.session?.authed) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  });
});

// ── Moonshine backend probe ───────────────────────────────────────────────────
const MOONSHINE_URL = process.env.MOONSHINE_URL || "http://moonshine:8765";
let moonshineAvailable = false;

async function probeMoonshine() {
  try {
    const res = await fetch(`${MOONSHINE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    moonshineAvailable = res.ok;
  } catch {
    moonshineAvailable = false;
  }
}

// Probe every 5s until moonshine responds, then every 30s
probeMoonshine();
const _moonshineStartupInterval = setInterval(async () => {
  await probeMoonshine();
  if (moonshineAvailable) {
    clearInterval(_moonshineStartupInterval);
    setInterval(probeMoonshine, 30_000);
    console.log("Moonshine backend is available.");
  }
}, 5_000);

app.get("/api/backends", (_req, res) => {
  res.json({ deepgram: true, moonshine: moonshineAvailable });
});

app.get("/api/moonshine-progress", async (_req, res) => {
  try {
    const r = await fetch(`${MOONSHINE_URL}/progress`, { signal: AbortSignal.timeout(3000) });
    res.json(await r.json());
  } catch {
    res.json({ current: 0, total: 0, active: false });
  }
});

async function getAudioDuration(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", filePath,
  ]);
  return parseFloat(stdout.trim()) || 30;
}

async function splitAudioChunks(audioPath, chunkDir, chunkSec = 30) {
  fs.mkdirSync(chunkDir, { recursive: true });
  await execFileAsync("ffmpeg", [
    "-i", audioPath,
    "-f", "segment", "-segment_time", String(chunkSec),
    "-c:a", "libmp3lame", "-ar", "16000", "-ac", "1", "-q:a", "4",
    path.join(chunkDir, "chunk%04d.mp3"),
  ]);
  return fs.readdirSync(chunkDir).filter(f => f.endsWith(".mp3")).sort();
}

function buildMoonshineResult(lines, duration) {
  const utterances = lines.map((line, i) => {
    const dg_words = (line.words || []).map(w => ({
      word: w.word.toLowerCase().replace(/[.,!?;:"']+$/, ""),
      start: w.start, end: w.end, confidence: 0.9,
      punctuated_word: w.word, speaker: line.speaker || 0, speaker_confidence: 0.9,
    }));
    return {
      id: String(i), start: line.start, end: line.end, confidence: 0.9,
      channel: 0, transcript: line.text, words: dg_words, speaker: line.speaker || 0,
    };
  });
  const allWords = utterances.flatMap(u => u.words);
  const fullTranscript = lines.map(l => l.text).join(" ");
  return {
    metadata: { transaction_key: "moonshine", request_id: `moonshine-${Date.now()}`,
      created: new Date().toISOString(), duration, channels: 1, models: ["moonshine"] },
    results: {
      channels: [{ alternatives: [{ transcript: fullTranscript, confidence: 0.9, words: allWords,
        paragraphs: { transcript: fullTranscript, paragraphs: lines.map(line => ({
          sentences: [{ text: line.text, start: line.start, end: line.end }],
          num_words: line.text.split(" ").length, start: line.start, end: line.end, speaker: line.speaker || 0,
        })) },
      }] }],
      utterances,
    },
  };
}

async function transcribeChunkWithMoonshine(chunkPath, offsetSec) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(chunkPath)]), "chunk.mp3");
  form.append("offset_sec", String(offsetSec));
  const res = await fetch(`${MOONSHINE_URL}/transcribe-chunk`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Moonshine chunk error ${res.status}: ${await res.text()}`);
  return res.json();
}

const PORT = process.env.SERVER_PORT || 3000;
server.listen(PORT, () => console.log(`Transcriber running on http://localhost:${PORT}`));