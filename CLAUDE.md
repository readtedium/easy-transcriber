# Transcriber

A self-hosted transcription web app powered by Deepgram's Nova-3 model. Supports file upload, YouTube/podcast URL transcription, and live dual-stream mic + system audio capture. Runs in Docker, accessible via browser.

## Stack

- **Backend**: Node.js (ESM), Express, ws (WebSocket), @deepgram/sdk, better-sqlite3, multer, ffmpeg, yt-dlp
- **Frontend**: Vanilla JS (`script.js`), CSS (`styles.css`), HTML (`index.html`) — no build step
- **AI**: Deepgram Nova-3 (transcription + diarization), DeepSeek (topic extraction)
- **Storage**: SQLite (`data/transcripts.db`), `media/` directory for audio files
- **Infrastructure**: Docker + docker-compose

## Project Structure

```
transcriber/
├── server.js              # Express + WebSocket server, all API routes
├── public/
│   ├── index.html         # App shell, no inline JS or CSS
│   ├── script.js          # All frontend logic
│   └── styles.css         # All styles, CSS variables for light/dark mode
├── media/                 # Saved audio files, keyed by history entry ID
├── uploads/               # Multer temp dir, files deleted after processing
├── data/
│   └── transcripts.db     # SQLite database (auto-created on first run)
├── Dockerfile
├── docker-compose.yml
└── .env                   # API keys, port, optional login password
```

## Environment Variables

```
DEEPGRAM_API_KEY=     # Required for transcription
DEEPSEEK_API_KEY=     # Optional — enables "Interesting Moments" topic extraction
SERVER_PORT=3000      # Port to expose on the host
LOGIN_PASSWORD=       # Optional — enables password-protected login page
SESSION_SECRET=       # Recommended when LOGIN_PASSWORD is set; random string
```

## Running

```bash
# First run
mkdir -p media uploads data
docker compose up --build

# Subsequent runs
docker compose up

# After changing server.js or Dockerfile
docker compose down && docker compose up --build

# After changing public/ files only
# Just hard-refresh the browser — no restart needed
```

## Architecture

### API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/history` | Returns all history entries with `mediaUrl` injected |
| `PATCH` | `/history/:id/filename` | Rename a history entry's title |
| `PATCH` | `/history/:id/speakers` | Update speaker name mappings for an entry |
| `DELETE` | `/history/:id` | Deletes entry + associated media file |
| `DELETE` | `/history` | Clears all history + all media files |
| `POST` | `/transcribe` | File upload → ffmpeg extract → Deepgram → DeepSeek topics |
| `POST` | `/transcribe-url` | yt-dlp download → Deepgram → DeepSeek topics |
| `POST` | `/save-live` | Multipart: mic + sys webm blobs → ffmpeg mix → save |
| `POST` | `/retopics/:id` | Regenerate DeepSeek topics for a history entry |
| `GET` | `/auth` | Returns `{ enabled: bool }` — whether password auth is active |
| `GET` | `/login` | Login page (only when LOGIN_PASSWORD is set) |
| `POST` | `/login` | Password check with timing-safe compare + rate limiting |
| `GET` | `/logout` | Destroys session |
| `WS` | `/live` | Proxy to Deepgram live WebSocket |

### WebSocket Live Transcription

The `/live` WebSocket accepts query params:
- `key` — Deepgram API key
- `dual=1` — dual stream mode (mic + system audio)
- `source=mic|system` — which Deepgram connection this socket feeds
- `keyterm=word` — repeatable; passed to Deepgram for vocabulary hints

In dual mode, the browser opens **two** WebSocket connections — one for mic, one for system audio. Each connects to a separate Deepgram live session. Transcripts come back tagged with `source` so the frontend can assign speaker indices (mic = Speaker 1, system = Speaker 2+).

### History Entry Schema

```json
{
  "id": "1774046728429",
  "filename": "interview.mp4",
  "createdAt": "2026-03-20T22:45:28.429Z",
  "ytId": "8V4bC_V8iQc",
  "sourceUrl": "https://www.youtube.com/watch?v=8V4bC_V8iQc",
  "topics": [{ "start": 94, "end": 112, "label": "Interesting moment label" }],
  "speakerNames": { "0": "Alice", "1": "Bob" },
  "result": { /* full Deepgram response object */ }
}
```

`mediaUrl` is not stored — it's injected at read time by checking `media/<id>.mp3` or `media/<id>.webm` exists.

### Database

SQLite via `better-sqlite3`. Schema: single `history` table with columns `id`, `filename`, `created_at`, `yt_id`, `source_url`, `result` (JSON), `topics` (JSON), `speaker_names` (JSON).

On first boot, if a `history.json` exists it is automatically migrated into SQLite and renamed to `history.json.migrated`.

### Audio Pipeline

- **Video upload**: ffmpeg extracts audio → 44.1kHz stereo MP3 at 192kbps → saved to `media/<id>.mp3`
- **Audio upload**: same ffmpeg path (handles format normalization)
- **URL**: yt-dlp downloads best audio → ffmpeg remux to MP3 → sent to Deepgram → deleted (not saved)
- **Live mic only**: webm chunks collected in `liveChunks[]` → ffmpeg remux on save → `media/<id>.webm`
- **Live dual stream**: mic in `liveChunks[]`, system in `sysChunks[]` → ffmpeg `amix` → `media/<id>.webm`

### Topic Extraction

Runs after every upload/URL transcription. Chunks utterances into ~5-minute windows, calls DeepSeek on each chunk, collects candidates, then runs a curation pass to select the best 10-20. Timestamps are sent as raw seconds (not MM:SS) to avoid DeepSeek misinterpretation.

Skipped if `DEEPSEEK_API_KEY` is not set.

### Auth

Optional. When `LOGIN_PASSWORD` is set: session-based auth (7-day cookie), timing-safe password compare, rate limiting (10 attempts per 15 min) on the login endpoint. WebSocket upgrade also checks session. `SESSION_SECRET` stabilizes sessions across restarts; if omitted, a new secret is generated each restart (logging everyone out).

## Frontend Conventions

- `$("id")` helper used throughout instead of `document.getElementById`
- `player` variable is reassigned via `setPlayerSrc()` and `wirePlayerSync()` — always use these, never set `player.src` directly
- `renderResult(result, fromHistory, ytId)` is the single render path for all transcript views
- Live transcripts use a separate render path (`renderLiveTimeline`) since they build incrementally
- YouTube embeds use the IFrame API with a 500ms polling interval for timeline sync
- Native video/audio uses `timeupdate` event for timeline sync
- Speaker colors are assigned by index from `SPEAKER_COLORS` array (6 colors, wraps)
- Speaker names are editable inline; prior names are remembered and offered as suggestions

## Known Issues / Planned Work

- **Export**: Only `.txt` export currently; SRT and DOCX planned
- **Mobile**: Layout not optimized for mobile
- **Moonshine backend**: Local offline transcription — in roadmap
- **Alternative AI backends**: Claude, Ollama, ChatGPT as alternatives to DeepSeek — in roadmap
- **YouTube closed captions**: Fallback option for URL transcription — in roadmap

## Roadmap

1. Additional transcription engines (Whisper, Moonshine)
2. Alternatives to DeepSeek for topic extraction (Claude, Ollama, ChatGPT)
3. YouTube closed captions fallback
4. SRT export
5. Docker Hub image publish
