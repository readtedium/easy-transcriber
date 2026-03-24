# Transcriber

A self-hosted transcription web app powered by Deepgram's Nova-3 model. Supports file upload, YouTube/podcast URL transcription, and live dual-stream mic + system audio capture. Runs in Docker, accessible via browser.

## Stack

- **Backend**: Node.js (ESM), Express, ws (WebSocket), @deepgram/sdk, multer, ffmpeg, yt-dlp
- **Frontend**: Vanilla JS (`script.js`), CSS (`styles.css`), HTML (`index.html`) — no build step
- **AI**: Deepgram Nova-3 (transcription + diarization), DeepSeek (topic extraction)
- **Storage**: `history.json` (flat file, SQLite migration planned), `media/` directory for audio files
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
├── history.json           # Transcript history, array of entry objects
├── Dockerfile
├── docker-compose.yml
└── .env                   # DEEPGRAM_API_KEY, DEEPSEEK_API_KEY, SERVER_PORT
```

## Environment Variables

```
DEEPGRAM_API_KEY=     # Required for transcription
DEEPSEEK_API_KEY=     # Optional — enables "Interesting Moments" topic extraction
SERVER_PORT=3435      # External port (internal always 3000)
```

Note: use `SERVER_PORT` not `PORT` — `PORT` conflicts with Docker/Node internals.

## Running

```bash
# First run
mkdir -p media uploads
echo "[]" > history.json
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
| `DELETE` | `/history/:id` | Deletes entry + associated media file |
| `DELETE` | `/history` | Clears all history + all media files |
| `POST` | `/transcribe` | File upload → ffmpeg extract → Deepgram → DeepSeek topics |
| `POST` | `/transcribe-url` | yt-dlp download → Deepgram → DeepSeek topics |
| `POST` | `/save-live` | Multipart: mic + sys webm blobs → ffmpeg mix → save |
| `POST` | `/retopics/:id` | Regenerate DeepSeek topics for a history entry |
| `WS` | `/live` | Proxy to Deepgram live WebSocket |

### WebSocket Live Transcription

The `/live` WebSocket accepts query params:
- `key` — Deepgram API key
- `dual=1` — dual stream mode (mic + system audio)
- `source=mic|system` — which Deepgram connection this socket feeds

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
  "result": { /* full Deepgram response object */ }
}
```

`mediaUrl` is not stored — it's injected at read time by checking `media/<id>.mp3` or `media/<id>.webm` exists.

### Audio Pipeline

- **Video upload**: ffmpeg extracts audio → 44.1kHz stereo MP3 at 192kbps → saved to `media/<id>.mp3`
- **Audio upload**: same ffmpeg path (handles format normalization)
- **URL**: yt-dlp downloads best audio → ffmpeg remux to MP3 → sent to Deepgram → deleted (not saved)
- **Live mic only**: webm chunks collected in `liveChunks[]` → ffmpeg remux on save → `media/<id>.webm`
- **Live dual stream**: mic in `liveChunks[]`, system in `sysChunks[]` → ffmpeg `amix` → `media/<id>.webm`

### Topic Extraction

Runs after every upload/URL transcription. Chunks utterances into 10-minute windows, calls DeepSeek on each chunk, collects candidates, then runs a curation pass to select the best 10-20. Timestamps are sent as raw seconds (not MM:SS) to avoid DeepSeek misinterpretation.

Skipped if `DEEPSEEK_API_KEY` is not set.

## Frontend Conventions

- `$("id")` helper used throughout instead of `document.getElementById`
- `player` variable is reassigned via `setPlayerSrc()` and `wirePlayerSync()` — always use these, never set `player.src` directly
- `renderResult(result, fromHistory, ytId)` is the single render path for all transcript views
- Live transcripts use a separate render path (`renderLiveTimeline`) since they build incrementally
- YouTube embeds use the IFrame API with a 500ms polling interval for timeline sync
- Native video/audio uses `timeupdate` event for timeline sync
- Speaker colors are assigned by index from `SPEAKER_COLORS` array (6 colors, wraps)

## Known Issues / Planned Work

- **Storage**: `history.json` is a flat file — SQLite migration planned before any public release
- **Speaker renaming**: UI to rename Speaker 1/2 to real names, not yet implemented
- **Dictionary/vocabulary**: Deepgram `keywords` param not yet exposed in UI
- **Moonshine backend**: Local offline transcription via Moonshine (no API key required) — confirmed working on Linux x86, integration planned
- **Auth**: No authentication — intended for single-user self-hosted use; auth needed before any multi-user deployment
- **Export**: Only `.txt` export currently; SRT and DOCX planned
- **Mobile**: Layout not optimized for mobile

## Roadmap to Open Source Release

1. SQLite migration (history.json → proper DB)
2. Speaker renaming UI
3. Moonshine local backend (offline mode)
4. Custom vocabulary / dictionary hints
5. SRT export
6. Clean README + one-command setup polish
7. Docker Hub image publish (eliminates local build requirement)