const $ = id => document.getElementById(id);

const SPEAKER_COLORS = [
  ["#eeecfe","#4a3fc7"],["#e1f5ee","#0f6e56"],["#faece7","#993c1d"],
  ["#fbeaf0","#993556"],["#e6f1fb","#185fa5"],["#eaf3de","#3b6d11"]
];

const fmtTime = s => `${String(Math.floor(s/60)).padStart(2,"0")}:${String(Math.floor(s%60)).padStart(2,"0")}`;
const fmtDate = iso => new Date(iso).toLocaleDateString(undefined, { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
const VIDEO_EXTS = /\.(mp4|mov|avi|webm|mkv|m4v)$/i;
const AUDIO_EXTS = /\.(mp3|m4a|flac|ogg|wav|webm|aac)$/i;

let player = $("media-player");
let currentHistoryId = null;
let currentSpeakerNames = {};

function speakerLabel(idx) {
  return currentSpeakerNames[idx] ?? `Speaker ${idx + 1}`;
}
function getNameBank() {
  try { return JSON.parse(localStorage.getItem("speakerNameBank") || "[]"); } catch { return []; }
}
function addToNameBank(name) {
  const bank = getNameBank();
  if (name && !bank.includes(name)) { bank.unshift(name); localStorage.setItem("speakerNameBank", JSON.stringify(bank.slice(0, 50))); }
}

// ── API key ───────────────────────────────────────────────────────────────────
const savedKey = localStorage.getItem("dg_key");
if (savedKey) $("api-key").value = savedKey;
$("api-key").addEventListener("input", () => localStorage.setItem("dg_key", $("api-key").value));

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    btn.classList.add("active");
    $("panel-upload").style.display = btn.dataset.tab === "upload" ? "" : "none";
    $("panel-live").style.display   = btn.dataset.tab === "live"   ? "" : "none";
  });
});

// ── Player helper ─────────────────────────────────────────────────────────────
function setPlayerSrc(src, isAudio = false) {
  player = $("media-player");
  player.src = src;
  if (isAudio) player.setAttribute("data-audio", "");
  else player.removeAttribute("data-audio");
}

// ── YouTube ───────────────────────────────────────────────────────────────────
let ytPlayer = null, ytReady = false, ytSyncInterval = null;

function getYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("?")[0];
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
  } catch {}
  return null;
}

window.onYouTubeIframeAPIReady = () => { ytReady = true; };

function mountYouTubePlayer(videoId) {
  if (ytSyncInterval) { clearInterval(ytSyncInterval); ytSyncInterval = null; }
  player.style.display = "none";
  player.src = "";
  $("yt-container").style.display = "block";
  $("btn-reattach").style.display = "none";
  $("history-notice").style.display = "none";

  const mount = () => {
    if (ytPlayer) { ytPlayer.destroy(); ytPlayer = null; }
    $("yt-container").innerHTML = `<div id="yt-player"></div>`;
    ytPlayer = new YT.Player("yt-player", {
      videoId, width: "100%", height: "100%",
      playerVars: { autoplay: 0, rel: 0, modestbranding: 1 },
    });
    ytSyncInterval = setInterval(() => {
      if (!ytPlayer || typeof ytPlayer.getCurrentTime !== "function") return;
      const state = ytPlayer.getPlayerState();
      if (state !== 1 && state !== 2) return;
      syncTimeline(ytPlayer.getCurrentTime());
    }, 500);
  };

  if (ytReady && typeof YT !== "undefined" && YT.Player) mount();
  else {
    const poll = setInterval(() => {
      if (typeof YT !== "undefined" && YT.Player) { clearInterval(poll); ytReady = true; mount(); }
    }, 100);
  }
}

function seekYouTube(secs) {
  if (ytPlayer && typeof ytPlayer.seekTo === "function") {
    ytPlayer.seekTo(secs, true); ytPlayer.playVideo();
  }
}

// ── Timeline sync ─────────────────────────────────────────────────────────────
function syncTimeline(t) {
  const all = [...document.querySelectorAll(".utterance")];
  all.forEach((u, i) => {
    const s = parseFloat(u.dataset.start);
    const e = all[i+1] ? parseFloat(all[i+1].dataset.start) : Infinity;
    const active = t >= s && t < e;
    u.classList.toggle("active", active);
    if (active && $("chk-autoscroll").checked) u.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function wirePlayerSync() {
  const old = $("media-player");
  const fresh = old.cloneNode(true);
  old.parentNode.replaceChild(fresh, old);
  fresh.id = "media-player";
  player = fresh;
  fresh.addEventListener("timeupdate", () => syncTimeline(fresh.currentTime));
}

// ── File drop / select ────────────────────────────────────────────────────────
const dropZone = $("drop-zone");
dropZone.addEventListener("click", () => $("file-input").click());
dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("over"));
dropZone.addEventListener("drop", e => { e.preventDefault(); dropZone.classList.remove("over"); handleFile(e.dataTransfer.files[0]); });
$("file-input").addEventListener("change", () => handleFile($("file-input").files[0]));

function handleFile(file) {
  if (!file) return;
  const key = $("api-key").value.trim();
  const isVideo = file.type.startsWith("video/") || VIDEO_EXTS.test(file.name);

  if (ytSyncInterval) { clearInterval(ytSyncInterval); ytSyncInterval = null; }
  if (ytPlayer) { ytPlayer.destroy(); ytPlayer = null; }
  $("yt-container").style.display = "none";
  player.style.display = "";
  setPlayerSrc(URL.createObjectURL(file), !isVideo);

  $("media-wrapper").style.display = "block";
  $("history-notice").style.display = "none";
  $("btn-reattach").style.display = "none";
  $("media-label").textContent = isVideo ? "Video" : "Audio";
  $("results").classList.remove("show");
  $("timeline").innerHTML = "";
  $("summary-card").style.display = "none";
  $("progress-wrap").style.display = "";
  $("status").textContent = isVideo ? "Extracting audio…" : "Uploading…";
  $("upload-progress").value = 10;

  const fd = new FormData();
  fd.append("audio", file);
  const keyterms = $("keyterms").value.trim();
  if (keyterms) fd.append("keyterms", keyterms);
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/transcribe");
  xhr.setRequestHeader("x-deepgram-key", key);
  xhr.upload.onprogress = e => { if (e.lengthComputable) $("upload-progress").value = Math.round((e.loaded/e.total)*60); };
  xhr.onload = () => {
    $("upload-progress").value = 100;
    if (xhr.status === 200) {
      $("status").textContent = "Done.";
      const data = JSON.parse(xhr.responseText);
      currentHistoryId = data._historyId;
      renderResult(data, false, null);
      loadHistorySidebar();
    } else {
      $("status").textContent = "Error: " + (JSON.parse(xhr.responseText).error || "Unknown");
    }
  };
  xhr.onerror = () => { $("status").textContent = "Network error"; };
  xhr.send(fd);
  $("status").textContent = isVideo ? "Transcribing (audio extracted)…" : "Transcribing…";
  $("topics-card").style.display = "none";
  $("topics-list").innerHTML = "";
}

// ── URL transcription ─────────────────────────────────────────────────────────
$("btn-url").addEventListener("click", handleUrl);
$("url-input").addEventListener("keydown", e => { if (e.key === "Enter") handleUrl(); });

async function handleUrl() {
  const url = $("url-input").value.trim();
  if (!url) return;
  const key = $("api-key").value.trim();
  const ytId = getYouTubeId(url);

  $("results").classList.remove("show");
  $("timeline").innerHTML = "";
  $("summary-card").style.display = "none";
  $("progress-wrap").style.display = "";
  $("upload-progress").value = 15;
  $("status").textContent = "Downloading audio…";
  $("btn-url").disabled = true;
  $("btn-url").textContent = "Working…";

  try {
    const res = await fetch("/transcribe-url", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-deepgram-key": key },
      body: JSON.stringify({ url, keyterms: $("keyterms").value.trim() }),
    });
    $("upload-progress").value = 90;
    if (!res.ok) { $("status").textContent = "Error: " + ((await res.json()).error || "Unknown"); return; }
    const data = await res.json();
    $("upload-progress").value = 100;
    $("status").textContent = "Done.";
    currentHistoryId = data._historyId;
    $("media-wrapper").style.display = "block";
    $("media-label").textContent = data._title || url;

    if (ytId) {
      mountYouTubePlayer(ytId);
      renderResult(data, false, ytId);
    } else {
      player.style.display = "none";
      $("yt-container").style.display = "none";
      $("history-notice").style.display = "";
      $("btn-reattach").style.display = "";
      renderResult(data, true, null);
    }
    loadHistorySidebar();
    $("url-input").value = "";
  } finally {
    $("btn-url").disabled = false;
    $("btn-url").textContent = "Transcribe URL";
  }
}

// ── Render result ─────────────────────────────────────────────────────────────
function renderResult(result, fromHistory = false, ytId = null) {
  currentSpeakerNames = result._speakerNames || {};
  const ch = result?.results?.channels?.[0];
  const utterances = result?.results?.utterances || [];
  const summary = result?.results?.summary?.short;
  const paragraphs = ch?.alternatives?.[0]?.paragraphs?.paragraphs;

  if (summary) { $("summary-text").textContent = summary; $("summary-card").style.display = ""; }
  else { $("summary-card").style.display = "none"; }

  $("timeline").innerHTML = "";

  const items = paragraphs
    ? paragraphs.flatMap(p => p.sentences.map(s => ({ start: s.start, end: s.end, transcript: s.text, speaker: p.speaker ?? 0 })))
    : utterances.length
      ? utterances
      : [{ start: 0, end: 0, transcript: ch?.alternatives?.[0]?.transcript || "", speaker: 0 }];

  window._currentItems = items;

  items.forEach(utt => {
    const [bg, fg] = SPEAKER_COLORS[(utt.speaker ?? 0) % SPEAKER_COLORS.length];
    const div = document.createElement("div");
    div.className = "utterance";
    div.dataset.start = utt.start;
    div.innerHTML = `<span class="utt-time">${fmtTime(utt.start)}</span><span class="utt-speaker" data-speaker="${utt.speaker??0}" style="background:${bg};color:${fg}">${speakerLabel(utt.speaker??0)}</span><span class="utt-text">${utt.transcript}</span>`;
    div.addEventListener("click", () => {
      if (ytId) seekYouTube(utt.start);
      else if (player.src && player.src !== window.location.href) { player.currentTime = utt.start; player.play(); }
      document.querySelectorAll(".utterance").forEach(u => u.classList.remove("active"));
      div.classList.add("active");
    });
    $("timeline").appendChild(div);
  });

  wireRenameBadges();

  if (!fromHistory) {
    if (!ytId) wirePlayerSync();
    $("btn-reattach").style.display = "none";
    $("history-notice").style.display = "none";
  } else {
    const storedYtId = result._ytId || result.ytId || null;
    if (storedYtId) { mountYouTubePlayer(storedYtId); renderResult(result, false, storedYtId); return; }
    else { $("btn-reattach").style.display = ""; $("history-notice").style.display = ""; }
  }

  $("results").classList.add("show");
  $("progress-wrap").style.display = "none";

  // Render topics if present, hide if not
  renderTopics(result._topics || null, ytId, result._historyId || currentHistoryId || null);

  $("btn-copy").onclick = () => {
    navigator.clipboard.writeText(items.map(u => `[${fmtTime(u.start)}] ${speakerLabel(u.speaker??0)}: ${u.transcript}`).join("\n"));
    $("btn-copy").textContent = "Copied!";
    setTimeout(() => $("btn-copy").textContent = "Copy text", 2000);
  };
  $("btn-txt").onclick = () => {
    const lines = summary ? [`SUMMARY\n${summary}\n\n---\n`] : [];
    lines.push(...items.map(u => `[${fmtTime(u.start)}] ${speakerLabel(u.speaker??0)}: ${u.transcript}`));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain" }));
    a.download = "transcript.txt"; a.click();
  };

  const resetBtn = $("btn-reset-names");
  resetBtn.style.display = Object.keys(currentSpeakerNames).length ? "" : "none";
  resetBtn.onclick = () => {
    currentSpeakerNames = {};
    document.querySelectorAll(".utt-speaker[data-speaker]").forEach(b => {
      b.textContent = speakerLabel(parseInt(b.dataset.speaker, 10));
    });
    resetBtn.style.display = "none";
    if (currentHistoryId) {
      fetch(`/history/${currentHistoryId}/speakers`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speakerNames: null }),
      });
    }
  };
}

// ── Topics ────────────────────────────────────────────────────────────────────
function renderTopics(topics, ytId = null, historyId = null) {
  const card = $("topics-card");
  const list = $("topics-list");
  const loading = $("topics-loading");
  loading.style.display = "none";

  // Update refresh button
  const refreshBtn = $("btn-refresh-topics");
  if (historyId) {
    refreshBtn.style.display = "";
    refreshBtn.onclick = async () => {
      refreshBtn.textContent = "Refreshing…";
      refreshBtn.disabled = true;
      loading.style.display = "";
      list.innerHTML = "";
      try {
        const res = await fetch(`/retopics/${historyId}`, { method: "POST" });
        const data = await res.json();
        renderTopics(data.topics, ytId, historyId);
      } catch {
        loading.style.display = "none";
      } finally {
        refreshBtn.textContent = "Refresh";
        refreshBtn.disabled = false;
      }
    };
  } else {
    refreshBtn.style.display = "none";
  }

  list.innerHTML = "";
  if (!topics?.length) { card.style.display = "none"; return; }

  const SHOW = 10;
  const visible = topics.slice(0, SHOW);
  const hidden = topics.slice(SHOW);

  function makeItem(t) {
    const item = document.createElement("div");
    item.className = "topic-item";
    item.innerHTML = `<span class="topic-time">${fmtTime(t.start)}</span><span class="topic-label">${t.label}</span>`;
    item.addEventListener("click", () => {
      if (ytId) seekYouTube(t.start);
      else if (player.src && player.src !== window.location.href) { player.currentTime = t.start; player.play(); }
    });
    return item;
  }

  visible.forEach(t => list.appendChild(makeItem(t)));

  if (hidden.length) {
    const expandWrap = document.createElement("div");
    expandWrap.style.cssText = "width:100%;margin-top:4px;";
    const expandBtn = document.createElement("button");
    expandBtn.className = "topics-expand-btn";
    expandBtn.textContent = `Show ${hidden.length} more`;
    let expanded = false;
    const extraItems = hidden.map(makeItem);
    expandBtn.addEventListener("click", () => {
      expanded = !expanded;
      extraItems.forEach(el => { el.style.display = expanded ? "" : "none"; list.insertBefore(el, expandWrap); });
      if (expanded) extraItems.forEach(el => list.insertBefore(el, expandWrap));
      else extraItems.forEach(el => el.remove());
      expandBtn.textContent = expanded ? "Show less" : `Show ${hidden.length} more`;
    });
    expandWrap.appendChild(expandBtn);
    list.appendChild(expandWrap);
  }

  card.style.display = "";
}


// ── Speaker renaming ──────────────────────────────────────────────────────────
function wireRenameBadges() {
  document.querySelectorAll(".utt-speaker").forEach(badge => {
    badge.style.cursor = "pointer";
    badge.title = "Click to rename";
    badge.addEventListener("click", () => {
      if (badge.querySelector("input")) return; // already editing

      const speakerIdx = parseInt(badge.dataset.speaker, 10);
      const currentName = currentSpeakerNames[speakerIdx] ?? "";
      const fg = badge.style.color;

      const input = document.createElement("input");
      input.value = currentName;
      input.style.cssText = `background:transparent;border:none;outline:none;color:${fg};font:inherit;width:${Math.max(120, currentName.length * 9 + 20)}px;padding:0;`;
      badge.textContent = "";
      badge.appendChild(input);
      input.focus();
      input.select();

      // Custom dropdown — shows all bank names, filters as you type
      let dropdown = null;

      function removeDropdown() { dropdown?.remove(); dropdown = null; }

      function showDropdown(filter = "") {
        removeDropdown();
        const bank = getNameBank();
        const matches = filter ? bank.filter(n => n.toLowerCase().includes(filter.toLowerCase())) : [...bank];
        if (!matches.length) return;

        dropdown = document.createElement("div");
        dropdown.className = "speaker-name-dropdown";
        const rect = badge.getBoundingClientRect();
        dropdown.style.cssText = `position:fixed;top:${rect.bottom + 3}px;left:${rect.left}px;z-index:9999;min-width:${Math.max(rect.width, 100)}px;`;
        matches.forEach(name => {
          const item = document.createElement("div");
          item.className = "speaker-name-option";
          item.addEventListener("mouseover", () => item.classList.add("hover"));
          item.addEventListener("mouseout", () => item.classList.remove("hover"));

          const label = document.createElement("span");
          label.textContent = name;
          label.addEventListener("mousedown", e => {
            e.preventDefault();
            input.value = name;
            removeDropdown();
            doCommit();
          });

          const del = document.createElement("button");
          del.className = "speaker-name-delete";
          del.textContent = "✕";
          del.title = "Remove from suggestions";
          del.addEventListener("mousedown", e => {
            e.preventDefault();
            const bank = getNameBank().filter(n => n !== name);
            localStorage.setItem("speakerNameBank", JSON.stringify(bank));
            if (input.value.trim() === name) input.value = "";
            showDropdown(input.value);
          });

          item.appendChild(label);
          item.appendChild(del);
          dropdown.appendChild(item);
        });
        document.body.appendChild(dropdown);
      }

      if (getNameBank().length) showDropdown();
      input.addEventListener("input", () => showDropdown(input.value));

      let done = false;
      function doCommit() {
        if (done) return;
        done = true;
        removeDropdown();
        const name = input.value.trim();
        if (name) {
          currentSpeakerNames[speakerIdx] = name;
          addToNameBank(name);
        } else {
          delete currentSpeakerNames[speakerIdx];
        }
        $("btn-reset-names").style.display = Object.keys(currentSpeakerNames).length ? "" : "none";
        document.querySelectorAll(`.utt-speaker[data-speaker="${speakerIdx}"]`).forEach(b => {
          b.textContent = speakerLabel(speakerIdx);
        });
        if (currentHistoryId) {
          fetch(`/history/${currentHistoryId}/speakers`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ speakerNames: { [speakerIdx]: name || null } }),
          });
        }
      }

      input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
      input.addEventListener("blur", doCommit, { once: true });
    });
  });
}

$("btn-reattach").addEventListener("click", () => $("reattach-input").click());
$("reattach-input").addEventListener("change", () => {
  const file = $("reattach-input").files[0];
  if (!file) return;
  $("yt-container").style.display = "none";
  player.style.display = "";
  const isVideo = file.type.startsWith("video/") || VIDEO_EXTS.test(file.name);
  setPlayerSrc(URL.createObjectURL(file), !isVideo);
  $("history-notice").style.display = "none";
  $("btn-reattach").textContent = "Swap file";
  $("media-label").textContent = file.name;
  wirePlayerSync();
  document.querySelectorAll(".utterance").forEach(div => {
    const fresh = div.cloneNode(true);
    div.parentNode.replaceChild(fresh, div);
    fresh.addEventListener("click", () => {
      player.currentTime = parseFloat(fresh.dataset.start); player.play();
      document.querySelectorAll(".utterance").forEach(u => u.classList.remove("active"));
      fresh.classList.add("active");
    });
  });
});

// ── History sidebar ───────────────────────────────────────────────────────────
async function loadHistorySidebar() {
  const res = await fetch("/history");
  const items = await res.json();
  const list = $("history-list");
  list.innerHTML = "";
  if (!items.length) { list.innerHTML = `<div id="history-empty">No transcripts yet</div>`; return; }
  items.forEach(entry => {
    const div = document.createElement("div");
    div.className = "hist-item" + (entry.id === currentHistoryId ? " active" : "");
    div.dataset.id = entry.id;
    div.innerHTML = `
      <div class="hist-meta">
        <div class="hist-name" title="${entry.filename}">${entry.filename}</div>
        <div class="hist-date">${fmtDate(entry.createdAt)}</div>
      </div>
      <button class="hist-del" title="Delete">✕</button>`;
    div.addEventListener("click", e => {
      if (e.target.classList.contains("hist-del")) return;
      document.querySelectorAll(".hist-item").forEach(i => i.classList.remove("active"));
      div.classList.add("active");
      currentHistoryId = entry.id;
      $("media-wrapper").style.display = "block";
      $("media-label").textContent = entry.filename;
      if (ytSyncInterval) { clearInterval(ytSyncInterval); ytSyncInterval = null; }
      $("yt-container").style.display = "none";
      player.style.display = "";
      player.src = "";

      if (entry.mediaUrl) {
        setPlayerSrc(entry.mediaUrl, AUDIO_EXTS.test(entry.mediaUrl));
        $("history-notice").style.display = "none";
        $("btn-reattach").style.display = "none";
      } else if (!entry.ytId && entry.sourceUrl) {
        const noticeEl = $("history-notice");
        noticeEl.style.display = "";
        noticeEl.innerHTML = "";
        const a = document.createElement("a");
        a.href = entry.sourceUrl; a.target = "_blank";
        a.style.cssText = "font-size:12px;color:var(--accent);margin-top:4px;display:inline-block;";
        a.textContent = "Open original URL";
        noticeEl.appendChild(a);
        $("btn-reattach").style.display = "none";
      } else if (!entry.ytId) {
        $("btn-reattach").style.display = "";
        $("history-notice").style.display = "";
      }

      renderResult({ ...entry.result, _ytId: entry.ytId || null, _topics: entry.topics || null, _historyId: entry.id, _speakerNames: entry.speakerNames || {} }, true, null);
    });
    div.querySelector(".hist-del").addEventListener("click", async () => {
      await fetch(`/history/${entry.id}`, { method: "DELETE" });
      if (currentHistoryId === entry.id) { $("results").classList.remove("show"); $("media-wrapper").style.display = "none"; }
      loadHistorySidebar();
    });
    list.appendChild(div);
  });
}

$("btn-clear-all").addEventListener("click", async () => {
  if (!confirm("Delete all transcript history?")) return;
  await fetch("/history", { method: "DELETE" });
  $("results").classList.remove("show");
  $("media-wrapper").style.display = "none";
  currentHistoryId = null;
  loadHistorySidebar();
});

// ── Level meter ───────────────────────────────────────────────────────────────
let meterAnimFrame = null;

function startMeter(streams) {
  const canvas = $("level-meter");
  canvas.style.display = "block";
  const ctx = canvas.getContext("2d");
  const ac = new AudioContext();
  const analyser = ac.createAnalyser();
  analyser.fftSize = 256;

  // Connect all streams to the same analyser for the meter
  streams.forEach(s => ac.createMediaStreamSource(s).connect(analyser));

  const buf = new Uint8Array(analyser.frequencyBinCount);

  function draw() {
    meterAnimFrame = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(buf);
    const w = canvas.offsetWidth;
    canvas.width = w;
    ctx.clearRect(0, 0, w, 32);
    const barW = Math.max(2, w / buf.length - 1);
    buf.forEach((v, i) => {
      const pct = v / 255;
      const r = Math.round(pct * 138);
      const g = Math.round(110 + pct * 40);
      const b = Math.round(pct < 0.5 ? 165 : 165 - pct * 100);
      ctx.fillStyle = `rgba(${r},${g},${b},0.85)`;
      const h = pct * 32;
      ctx.fillRect(i * (barW + 1), 32 - h, barW, h);
    });
  }
  draw();

  return () => {
    cancelAnimationFrame(meterAnimFrame);
    meterAnimFrame = null;
    canvas.style.display = "none";
    ac.close();
  };
}

// ── Live transcription ────────────────────────────────────────────────────────
// ── Live transcript merge + render ────────────────────────────────────────────
function mergeLiveTranscript(data, speakerIndex) {
  const alt = data.channel?.alternatives?.[0];
  if (!alt?.transcript) return;
  const start = alt.words?.[0]?.start ?? 0;
  const end = alt.words?.[alt.words.length - 1]?.end ?? start;
  liveUtterances.push({ start, end, transcript: alt.transcript, speaker: speakerIndex });
  liveUtterances.sort((a, b) => a.start - b.start);
  liveText = liveUtterances.map(u => u.transcript).join(" ");
  renderLiveTimeline();
}

function renderLiveTimeline() {
  const el = $("live-transcript");
  el.innerHTML = "";
  liveUtterances.forEach(utt => {
    const [bg, fg] = SPEAKER_COLORS[utt.speaker % SPEAKER_COLORS.length];
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:flex-start;gap:8px;margin-bottom:4px;";
    row.innerHTML = `<span style="font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px;background:${bg};color:${fg};white-space:nowrap;align-self:flex-start;">Speaker ${utt.speaker + 1}</span><span style="font-size:14px;line-height:1.6;">${utt.transcript}</span>`;
    el.appendChild(row);
  });
  el.scrollTop = el.scrollHeight;
}

let mediaRecorder, wsLive, wsSystem, isRecording = false;
let liveText = "", liveRecordingStart = null, liveChunks = [], sysChunks = [];
let liveUtterances = [];
let stopMeter = null;

$("record-btn").addEventListener("click", () => isRecording ? stopLive() : startLive());

function openDgSocket(key, source) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/live?key=${encodeURIComponent(key)}&dual=1&source=${source}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  return ws;
}

async function startLive() {
  const key = $("api-key").value.trim();
  if (!key) { alert("Enter your Deepgram API key first."); return; }

  const useSystemAudio = $("chk-system-audio").checked;
  const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  let sysStream = null;

  if (useSystemAudio) {
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      displayStream.getVideoTracks().forEach(t => t.stop());
      const audioTracks = displayStream.getAudioTracks();
      if (audioTracks.length === 0) {
        alert("No system audio captured — make sure to check 'Share audio'. Falling back to mic only.");
      } else {
        sysStream = new MediaStream(audioTracks);
      }
    } catch (err) {
      console.warn("System audio capture failed:", err.message);
      alert("Couldn't capture system audio — falling back to mic only.");
    }
  }

  const dual = !!sysStream;
  stopMeter = startMeter([micStream, ...(sysStream ? [sysStream] : [])]);

  liveUtterances = [];
  liveChunks = [];
  liveText = "";
  $("live-transcript").innerHTML = "";
  $("live-interim").textContent = "";

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const mimeType = ["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus","audio/ogg"]
    .find(m => MediaRecorder.isTypeSupported(m)) || "";

  function makeRecorder(stream, onChunk) {
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    rec.ondataavailable = e => { if (e.data && e.data.size > 0) onChunk(e.data); };
    rec.start(250);
    return rec;
  }

  // ── Mic WebSocket ──────────────────────────────────────────────────────────
  const keytermParams = $("keyterms").value.trim().split(",")
    .map(k => k.trim()).filter(Boolean)
    .map(k => `&keyterm=${encodeURIComponent(k)}`).join("");
  const micUrl = dual
    ? `${proto}://${location.host}/live?key=${encodeURIComponent(key)}&dual=1&source=mic${keytermParams}`
    : `${proto}://${location.host}/live?key=${encodeURIComponent(key)}${keytermParams}`;
  wsLive = new WebSocket(micUrl);
  wsLive.binaryType = "arraybuffer";

  wsLive.onopen = () => {
    $("live-status").textContent = dual ? "Recording mic + system…" : "Recording…";
    mediaRecorder = makeRecorder(micStream, chunk => {
      liveChunks.push(chunk);
      console.log("mic chunk", liveChunks.length, chunk.size);
      if (wsLive.readyState === 1) wsLive.send(chunk);
    });
  };

  wsLive.onmessage = e => handleWsMessage(e, "mic");
  wsLive.onerror = e => { console.error("Mic WS error", e); };
  wsLive.onclose = () => { $("live-status").textContent = ""; };

  // ── System WebSocket (if dual) ─────────────────────────────────────────────
  if (sysStream) {
    const sysUrl = `${proto}://${location.host}/live?key=${encodeURIComponent(key)}&dual=1&source=system${keytermParams}`;
    wsSystem = new WebSocket(sysUrl);
    wsSystem.binaryType = "arraybuffer";

    wsSystem.onopen = () => {
      makeRecorder(sysStream, chunk => {
        sysChunks.push(chunk);
        if (wsSystem && wsSystem.readyState === 1) wsSystem.send(chunk);
      });
    };

    wsSystem.onmessage = e => handleWsMessage(e, "system");
    wsSystem.onerror = e => { console.error("System WS error", e); };
  }

  isRecording = true;
  liveRecordingStart = Date.now();
  $("chk-system-audio").disabled = true;
  $("record-btn").classList.add("recording");
  $("record-btn").innerHTML = `<span class="dot"></span> Stop recording`;
}

function handleWsMessage(e, source) {
  const msg = JSON.parse(e.data);
  if (msg.type === "connected") {
    const useSystemAudio = $("chk-system-audio").checked;
    $("live-status").textContent = useSystemAudio ? "Recording mic + system…" : "Recording…";
  }
  if (msg.type === "transcript") {
    const speakerIndex = source === "system" 
      ? (msg.data.channel?.alternatives?.[0]?.words?.[0]?.speaker ?? 0) + 2
      : (msg.data.channel?.alternatives?.[0]?.words?.[0]?.speaker ?? 0);
    if (msg.data.is_final) {
      mergeLiveTranscript(msg.data, speakerIndex);
      $("live-interim").textContent = "";
    } else {
      const alt = msg.data?.channel?.alternatives?.[0];
      if (alt?.transcript) $("live-interim").textContent = alt.transcript;
    }
  }
  if (msg.type === "error") { $("live-status").textContent = "Error: " + msg.message; stopLive(); }
}

function stopLive() {
  mediaRecorder?.stop();
  wsLive?.close();
  wsSystem?.close();
  wsSystem = null;
  if (stopMeter) { stopMeter(); stopMeter = null; }
  isRecording = false;
  $("chk-system-audio").disabled = false;
  $("record-btn").classList.remove("recording");
  $("record-btn").innerHTML = "&#x25CF; Start recording";
  $("live-status").textContent = "";

if (liveText.trim() && liveChunks.length) {
    const duration = liveRecordingStart ? (Date.now() - liveRecordingStart) / 1000 : 0;
    const fd = new FormData();
    fd.append("mic", new Blob(liveChunks, { type: "audio/webm" }), "mic.webm");
    if (sysChunks.length) fd.append("sys", new Blob(sysChunks, { type: "audio/webm" }), "sys.webm");
    fd.append("transcript", liveText);
    fd.append("duration", String(duration));
    fd.append("utterances", JSON.stringify(liveUtterances));
    fetch("/save-live", { method: "POST", body: fd })
      .then(r => r.json()).then(() => loadHistorySidebar());
  }

  liveText = "";
  liveChunks = [];
  sysChunks = [];
  liveUtterances = [];
  liveRecordingStart = null;
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadHistorySidebar();