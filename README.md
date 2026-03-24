# Easy Transcriber

![Easy Transcriber Screenshot](easy_transcriber_screenshot.jpg)

A self-hosted transcription web app powered by [Deepgram Nova-3](https://deepgram.com). Transcribe audio/video files, YouTube and podcast URLs, or live microphone input, all via a browser. Runs in Docker, intended for local hosting.

Built with the help of Claude over an evening, this is designed as a minimal alternative to Krisp or Otter.ai that costs pennies on the dollar and doesn’t force you into storing video recordings onto limited cloud storage. This also doesn’t tax the GPU as it’s running via an API. (If you’re a journalist, you might find this tool super-useful.)

Not sure if this is for you? Feel free to kick the tires—Deepgram offers new users $200 of free usage for testing, which will cover about 50 hours of recording. If you choose to add [DeepSeek](https://www.deepseek.com/), the cost is likewise minimal.

## Features

- **File upload** — MP3, MP4, MOV, WAV, M4A, FLAC, OGG, MKV up to 2 GB
    - Audio extracted from files to minimize size, but local copy of video can be reattached.
- **URL transcription** — YouTube, podcasts, and anything [yt-dlp](https://github.com/yt-dlp/yt-dlp) supports
- **Live mic transcription** — real-time streaming with speaker diarization
    - Capable of detecting multiple speakers
- **Dual-stream mode** — capture mic and system audio simultaneously as separate speakers
- **Interesting moments** — AI-powered topic extraction highlights the best moments (optional, requires DeepSeek key)
- **Transcript history** — sidebar with playback sync; click any word to jump to that moment
- **Export** — copy to clipboard or download as `.txt`
- **Light/dark mode**

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Compose
- A [Deepgram API key](https://console.deepgram.com/) (free tier available with up to $200 of usage for new users)

## Setup

```bash
# 1. Clone and enter the repo
git clone https://github.com/readtedium/easy-transcriber
cd transcriber

# 2. Create your .env
cp .env.example .env
# Edit .env and set DEEPGRAM_API_KEY

# 3. Initialize data directories
mkdir -p media uploads
echo "[]" > history.json

# 4. Build and start
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

> **No .env?** You can leave `DEEPGRAM_API_KEY` blank and paste your key directly into the UI instead. It's stored in browser `localStorage` and sent with each request.

## Configuration

Copy `.env.example` to `.env`:

```env
DEEPGRAM_API_KEY=   # Required for transcription
DEEPSEEK_API_KEY=   # Optional — enables "Interesting Moments" topic extraction
SERVER_PORT=3000    # Port to expose on the host (default: 3000)
```

## Usage

**Subsequent starts** (after first build):
```bash
docker compose up
```

**After editing server-side files** (`server.js`, `Dockerfile`):
```bash
docker compose down && docker compose up --build
```

**After editing frontend files** (`public/`):
Just hard-refresh the browser — no restart needed.

## Live Transcription

The **Live mic** tab streams audio to Deepgram in real time. Enable **Capture system audio** to record both your microphone and speaker output simultaneously, with each assigned to a separate speaker track.

> System audio capture uses the browser's `getDisplayMedia` API. You'll be prompted to share a tab or window; audio capture must be enabled in that prompt.

## Interesting Moments

When a `DEEPSEEK_API_KEY` is set, Transcriber automatically analyzes each transcript after it finishes and surfaces 10–20 notable timestamps with short labels. You can regenerate these at any time with the **Refresh** button.

## Running without Docker

You'll need Node.js 20+, `ffmpeg`, and `yt-dlp` installed on your system, then:

```bash
npm install
cp .env.example .env  # add your API key
mkdir -p media uploads && echo "[]" > history.json
node server.js
```

## Notes

- No authentication — intended for single-user self-hosted use. Do not expose to the public internet without adding auth.
- Transcript history is stored in `history.json`. The `media/` directory holds saved audio files. Both are mounted as Docker volumes so data persists across restarts.
- URL transcriptions are not saved to `media/` (audio is downloaded, transcribed, then deleted).

## Roadmap

- Move setup to SQLite database
- Set up custom speaker names
- Add authentication

## License

MIT
