"use strict";
(() => {
  // src/shared.ts
  var ext = globalThis.browser ?? globalThis.chrome;
  async function send(message) {
    try {
      return await ext.runtime.sendMessage(message);
    } catch (cause) {
      return { ok: false, error: { code: "EXTENSION_ERROR", message: "The extension is not responding.", detail: String(cause?.message ?? cause) } };
    }
  }
  var DEFAULTS = {
    downloadDirectory: "",
    askWhereToSave: false,
    videoQuality: "best",
    container: "mp4",
    audioFormat: "m4a",
    notifications: true,
    mp3Quality: "320",
    outputTemplate: "%(title)s [%(id)s].%(ext)s",
    overwrite: "never",
    maxConcurrent: 2,
    lastMode: "video"
  };
  async function getSettings() {
    const stored = await ext.storage.local.get("settings");
    return { ...DEFAULTS, ...stored?.settings ?? {} };
  }
  async function setSettings(patch) {
    const next = { ...await getSettings(), ...patch };
    await ext.storage.local.set({ settings: next });
    return next;
  }
  var HOSTS = /* @__PURE__ */ new Set(["www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
  var VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  function videoUrl(raw) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (!HOSTS.has(parsed.hostname.toLowerCase())) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    let id = null;
    let shorts = false;
    if (parsed.hostname === "youtu.be") id = parts[0] ?? null;
    else if (parts[0] === "shorts" || parts[0] === "live" || parts[0] === "embed") {
      id = parts[1] ?? null;
      shorts = parts[0] === "shorts";
    } else if (parsed.pathname === "/watch") id = parsed.searchParams.get("v");
    if (!id || !VIDEO_ID.test(id)) return null;
    return { id, url: `https://www.youtube.com/watch?v=${id}`, shorts };
  }
  function bytes(value, approx = false) {
    if (!value || !isFinite(value) || value <= 0) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let n = value;
    let u = 0;
    while (n >= 1024 && u < units.length - 1) {
      n /= 1024;
      u += 1;
    }
    return `${approx ? "~" : ""}${n.toFixed(n >= 100 || u === 0 ? 0 : 1)} ${units[u]}`;
  }
  function clock(seconds) {
    if (seconds == null || !isFinite(seconds) || seconds < 0) return "";
    const t = Math.round(seconds);
    const h = Math.floor(t / 3600);
    const m = Math.floor(t % 3600 / 60);
    const s = String(t % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // src/formats.ts
  var STEPS = [2160, 1440, 1080, 720, 480, 360];
  function clean(raw, duration) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const f of raw) {
      if (!f || typeof f.format_id !== "string") continue;
      const ext2 = String(f.ext ?? "").toLowerCase();
      const protocol = String(f.protocol ?? "").toLowerCase();
      if (ext2 === "mhtml" || protocol.startsWith("m3u8") || protocol === "ism" || protocol === "f4m") continue;
      const video = !!f.vcodec && f.vcodec !== "none";
      const audio = !!f.acodec && f.acodec !== "none";
      if (!video && !audio) continue;
      const tbr = typeof f.tbr === "number" ? f.tbr : 0;
      const size = f.filesize ?? f.filesize_approx ?? (tbr && duration ? Math.round(tbr * 1e3 * duration / 8) : null);
      out.push({
        id: f.format_id,
        ext: ext2,
        height: Number(f.height) || 0,
        fps: Number(f.fps) || 0,
        video,
        audio,
        abr: Number(f.abr) || 0,
        tbr,
        size: size ?? null
      });
    }
    return out;
  }
  function bestAudio(formats, container) {
    const wanted = container === "webm" ? /^webm$/ : container === "mp4" ? /^(m4a|mp4)$/ : /./;
    const audio = formats.filter((f) => f.audio && !f.video);
    return audio.sort((a, b) => (wanted.test(b.ext) ? 1e6 : 0) + (b.abr || b.tbr) - ((wanted.test(a.ext) ? 1e6 : 0) + (a.abr || a.tbr)))[0];
  }
  function bestVideo(bucket, container) {
    const wanted = container === "webm" ? /^webm$/ : /^mp4$/;
    return bucket.slice().sort((a, b) => score(b) - score(a))[0];
    function score(f) {
      return (wanted.test(f.ext) ? 4e3 : 0) + (f.audio ? 300 : 0) + (f.fps >= 50 ? 200 : 0) + f.tbr;
    }
  }
  function videoChoices(raw, duration, settings) {
    const formats = clean(raw, duration);
    const cap = settings.videoQuality === "best" ? Infinity : Number(settings.videoQuality);
    const videos = formats.filter((f) => f.video && f.height && f.height <= cap);
    if (!videos.length) return [];
    const audio = bestAudio(formats, settings.container);
    const limit = cap === Infinity ? "" : `[height<=${cap}]`;
    const top = bestVideo(videos.filter((f) => f.height === Math.max(...videos.map((v) => v.height))), settings.container);
    const choices = [{
      key: "best",
      label: "Best available",
      note: note(top, audio, `${top.height}p`),
      selector: `bestvideo*${limit}+bestaudio/best${limit}`,
      needsFfmpeg: !top.audio
    }];
    for (const step of STEPS) {
      if (step > cap) continue;
      const bucket = videos.filter((f) => f.height === step);
      if (!bucket.length) continue;
      const pick = bestVideo(bucket, settings.container);
      const merge = !pick.audio;
      if (merge && !audio) continue;
      const fallback = `bestvideo[height<=${step}]+bestaudio/best[height<=${step}]`;
      choices.push({
        key: `p${step}`,
        label: `${step}p`,
        note: note(pick, merge ? audio : void 0, ""),
        selector: merge ? `${pick.id}+${audio.id}/${fallback}` : `${pick.id}/${fallback}`,
        needsFfmpeg: merge
      });
    }
    return choices;
    function note(video, mergedAudio, prefix) {
      const size = video.size == null ? "" : bytes(video.size + (mergedAudio?.size ?? 0), true);
      return [prefix, video.fps >= 50 ? "60 fps" : "", size].filter(Boolean).join(" \u2022 ");
    }
  }
  function audioChoices(raw, duration, settings) {
    const formats = clean(raw, duration).filter((f) => f.audio && !f.video);
    if (!formats.length) return [];
    const best = formats.slice().sort((a, b) => (b.abr || b.tbr) - (a.abr || a.tbr))[0];
    const m4a = formats.filter((f) => /^(m4a|mp4)$/.test(f.ext)).sort((a, b) => b.abr - a.abr)[0];
    const opus = formats.filter((f) => f.ext === "webm").sort((a, b) => b.abr - a.abr)[0];
    const choices = [{
      key: "best",
      label: "Best available",
      note: bytes(best.size, true),
      selector: "bestaudio/best",
      audioFormat: "best",
      needsFfmpeg: false
    }];
    if (m4a) choices.push({
      key: "m4a",
      label: "M4A",
      note: bytes(m4a.size, true),
      selector: "bestaudio[ext=m4a]/bestaudio",
      audioFormat: "m4a",
      needsFfmpeg: false
    });
    choices.push({
      key: "mp3",
      label: "MP3",
      note: `converted from the ${Math.round(best.abr || best.tbr) || "?"} kbps source`,
      selector: "bestaudio/best",
      audioFormat: "mp3",
      needsFfmpeg: true
    });
    if (opus) choices.push({
      key: "opus",
      label: "Opus",
      note: bytes(opus.size, true),
      selector: "bestaudio[acodec^=opus]/bestaudio[ext=webm]/bestaudio",
      audioFormat: "opus",
      needsFfmpeg: false
    });
    return choices;
  }

  // src/content.ts
  var BUTTON_ID = "ytdlp-bridge-btn";
  var HOST_ID = "ytdlp-bridge-ui";
  var WATCH_ANCHORS = ["ytd-watch-metadata #top-level-buttons-computed", "#top-level-buttons-computed", "ytd-watch-metadata #actions"];
  var SHORTS_ANCHORS = ["ytd-reel-video-renderer[is-active] #actions", "#shorts-container #actions"];
  var observer = null;
  var currentId = null;
  function anchorFor(shorts) {
    for (const selector of shorts ? SHORTS_ANCHORS : WATCH_ANCHORS) {
      const node = document.querySelector(selector);
      if (node?.isConnected) return node;
    }
    return null;
  }
  function makeButton(shorts) {
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.title = "Download with yt-dlp";
    button.setAttribute("aria-label", "Download with yt-dlp");
    button.textContent = "Download";
    button.style.cssText = "display:inline-flex;align-items:center;height:36px;padding:0 14px;margin-left:8px;border:0;cursor:pointer;border-radius:18px;font:500 14px/36px Roboto,'Segoe UI',system-ui,sans-serif;background:var(--yt-spec-badge-chip-background,rgba(128,128,128,.18));color:var(--yt-spec-text-primary,inherit)" + (shorts ? ";margin:0;width:48px;height:48px;padding:0;border-radius:50%;font-size:0" : "");
    if (shorts) button.textContent = "\u2B73";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openDialog();
    });
    return button;
  }
  function place() {
    const target = videoUrl(location.href);
    const existing = document.getElementById(BUTTON_ID);
    if (!target) {
      existing?.remove();
      return true;
    }
    const anchor = anchorFor(target.shorts);
    if (!anchor) return false;
    if (existing?.parentElement === anchor) return true;
    existing?.remove();
    anchor.append(makeButton(target.shorts));
    return true;
  }
  function ensureButton() {
    observer?.disconnect();
    observer = null;
    if (place()) return;
    const scope = document.querySelector("ytd-watch-flexy, ytd-shorts, ytd-page-manager") ?? document.body;
    observer = new MutationObserver(() => {
      if (place()) {
        observer?.disconnect();
        observer = null;
      }
    });
    observer.observe(scope, { childList: true, subtree: true });
  }
  function onNavigate() {
    const target = videoUrl(location.href);
    if (target?.id !== currentId) {
      currentId = target?.id ?? null;
      closeDialog();
    }
    ensureButton();
  }
  var CSS = `
:host { all: initial; }
.back { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.5); padding: 20px; font: 14px/1.45 "Segoe UI", Roboto, system-ui, sans-serif; }
.card { width: min(420px,100%); max-height: 84vh; overflow: auto; background: #fff; color: #17171a;
  border-radius: 12px; box-shadow: 0 16px 48px rgba(0,0,0,.35); }
@media (prefers-color-scheme: dark) { .card { background: #1f1f23; color: #f1f1f3; } }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 16px; border-bottom: 1px solid rgba(128,128,128,.28); }
.head h2 { margin: 0; font-size: 16px; font-weight: 600; }
.x { border: 0; background: transparent; color: inherit; font-size: 20px; line-height: 1; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
.x:hover { background: rgba(128,128,128,.18); }
.body { padding: 16px; display: grid; gap: 14px; }
.video { display: flex; gap: 12px; align-items: flex-start; }
.video img { width: 96px; height: 54px; border-radius: 6px; object-fit: cover; background: rgba(128,128,128,.2); }
.t { font-weight: 600; margin: 0 0 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sub, .note { color: #5c5c66; font-size: 13px; margin: 0; }
@media (prefers-color-scheme: dark) { .sub, .note { color: #b4b4bd; } }
.label { font-weight: 600; margin: 0; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.big { padding: 18px 12px; border: 1px solid rgba(128,128,128,.4); border-radius: 10px; background: transparent; color: inherit;
  font: 600 15px inherit; cursor: pointer; }
.big:hover, .opt:hover { border-color: #2f6fed; }
.list { display: grid; gap: 6px; }
.opt { display: flex; justify-content: space-between; align-items: center; gap: 12px; width: 100%; text-align: left;
  padding: 11px 12px; border: 1px solid rgba(128,128,128,.4); border-radius: 10px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.opt[aria-checked="true"] { border-color: #2f6fed; box-shadow: inset 0 0 0 1px #2f6fed; }
.opt .name { font-weight: 600; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-top: 1px solid rgba(128,128,128,.28); }
.go { background: #2f6fed; color: #fff; border: 0; border-radius: 9px; padding: 10px 18px; font: 600 14px inherit; cursor: pointer; }
.go[disabled] { opacity: .5; cursor: not-allowed; }
.ghost { background: transparent; color: inherit; border: 1px solid rgba(128,128,128,.4); border-radius: 9px; padding: 9px 14px; font: 600 14px inherit; cursor: pointer; }
.bar { height: 6px; border-radius: 99px; background: rgba(128,128,128,.25); overflow: hidden; }
.bar i { display: block; height: 100%; background: #2f6fed; }
.det { white-space: pre-wrap; font: 11.5px ui-monospace, Consolas, monospace; background: rgba(128,128,128,.14);
  padding: 8px; border-radius: 8px; max-height: 140px; overflow: auto; }
input.dir { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(128,128,128,.45); background: transparent; color: inherit; font: inherit; }
button:focus-visible, input:focus-visible { outline: 2px solid #2f6fed; outline-offset: 2px; }
`;
  var root = null;
  var state = {};
  function card(title) {
    root.querySelector(".back")?.remove();
    const back = document.createElement("div");
    back.className = "back";
    back.addEventListener("mousedown", (e) => {
      if (e.target === back) closeDialog();
    });
    back.innerHTML = `<div class="card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
    <div class="head"><h2>${escapeHtml(title)}</h2><button class="x" aria-label="Close">\xD7</button></div>
    <div class="body"></div></div>`;
    back.querySelector(".x").addEventListener("click", closeDialog);
    root.append(back);
    back.querySelector(".x").focus();
    return back.querySelector(".body");
  }
  function onKey(event) {
    if (event.key === "Escape" && root) {
      event.preventDefault();
      closeDialog();
    }
  }
  function closeDialog() {
    document.getElementById(HOST_ID)?.remove();
    document.removeEventListener("keydown", onKey, true);
    root = null;
    state = {};
  }
  async function openDialog() {
    const target = videoUrl(location.href);
    if (!target) return;
    closeDialog();
    const host = document.createElement("div");
    host.id = HOST_ID;
    root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.append(style);
    document.body.append(host);
    document.addEventListener("keydown", onKey, true);
    card("Download").innerHTML = `<p class="sub">Reading available qualities\u2026</p>`;
    const [depsReply, infoReply] = await Promise.all([
      send({ type: "deps" }),
      send({ type: "info", url: target.url })
    ]);
    if (!root) return;
    if (!depsReply.ok) return showError(depsReply.error);
    state.deps = depsReply.data;
    if (!state.deps.ytdlp.found) {
      return showError({ code: "NO_YTDLP", message: "yt-dlp is not installed." });
    }
    if (!infoReply.ok) return showError(infoReply.error);
    state.info = infoReply.data;
    state.settings = await getSettings();
    state.dir = state.settings.downloadDirectory;
    showModes();
  }
  function header() {
    const i = state.info;
    return `<div class="video">
    ${i.thumbnail ? `<img alt="" src="${escapeHtml(safeUrl(i.thumbnail))}">` : `<img alt="">`}
    <div><p class="t">${escapeHtml(i.title)}</p>
      <p class="sub">${escapeHtml([i.uploader, clock(i.duration), i.isLive ? "Live" : ""].filter(Boolean).join(" \u2022 "))}</p></div>
  </div>`;
  }
  function safeUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === "https:" ? u.toString() : "";
    } catch {
      return "";
    }
  }
  function showModes() {
    const body = card("Download");
    body.innerHTML = `${header()}<p class="label">Download as</p>
    <div class="pair"><button class="big" data-m="video">Video</button><button class="big" data-m="audio">Music</button></div>`;
    body.querySelectorAll("[data-m]").forEach((button) => button.addEventListener("click", () => showChoices(button.dataset.m)));
  }
  function showChoices(mode) {
    const settings = state.settings;
    state.mode = mode;
    void setSettings({ lastMode: mode });
    const info = state.info;
    state.choices = mode === "video" ? videoChoices(info.formats, info.duration ?? null, settings) : audioChoices(info.formats, info.duration ?? null, settings);
    state.pick = state.choices.find((c) => c.key === (mode === "audio" ? settings.audioFormat : "best")) ?? state.choices[0];
    const body = card(mode === "video" ? "Video" : "Music");
    if (!state.choices.length) {
      body.innerHTML = `<p class="sub">No ${mode === "video" ? "video" : "audio"} formats are available for this video.</p>`;
      return;
    }
    body.innerHTML = `<p class="label" id="pick-label">${mode === "video" ? "Quality" : "Format"}</p>
    <div class="list" role="radiogroup" aria-labelledby="pick-label"></div>
    <p class="note">${mode === "video" ? `Saved as ${settings.container.toUpperCase()}` : ""}</p>
    ${settings.askWhereToSave ? `<label class="label" for="dir">Save to</label><input class="dir" id="dir" spellcheck="false" placeholder="Downloads folder" value="${escapeHtml(state.dir ?? "")}">` : ""}`;
    const list = body.querySelector(".list");
    for (const choice of state.choices) {
      const option = document.createElement("button");
      option.className = "opt";
      option.type = "button";
      option.setAttribute("role", "radio");
      option.setAttribute("aria-checked", String(choice.key === state.pick?.key));
      option.innerHTML = `<span class="name">${escapeHtml(choice.label)}</span><span class="note">${escapeHtml(choice.note)}</span>`;
      option.addEventListener("click", () => {
        state.pick = choice;
        showChoices(mode);
      });
      list.append(option);
    }
    body.querySelector("#dir")?.addEventListener("change", (e) => {
      state.dir = e.target.value.trim();
    });
    const foot = document.createElement("div");
    foot.className = "foot";
    const missing = state.pick?.needsFfmpeg && !state.deps?.ffmpeg.found;
    foot.innerHTML = `<span class="note">${missing ? "FFmpeg is required for this choice." : ""}</span>
    <span><button class="ghost" data-back>Back</button> <button class="go" ${missing ? "disabled" : ""}>Download</button></span>`;
    body.parentElement.append(foot);
    foot.querySelector("[data-back]").addEventListener("click", showModes);
    foot.querySelector(".go").addEventListener("click", () => void startDownload());
  }
  async function startDownload() {
    const { pick, info, mode } = state;
    if (!pick || !info) return;
    state.awaitingJob = true;
    showProgress({ id: "", state: "queued", title: info.title, label: pick.label, percent: 0, stage: "Starting" });
    const reply = await send({
      type: "download",
      url: location.href,
      mode,
      format: pick.selector,
      audioFormat: pick.audioFormat,
      outputDirectory: state.dir || "",
      title: info.title,
      label: pick.label
    });
    if (!reply.ok) {
      state.awaitingJob = false;
      return showError(reply.error);
    }
    state.jobId = reply.data.id;
    state.awaitingJob = false;
  }
  function showProgress(job) {
    const body = card(job.stage ?? "Downloading");
    const percent = Math.max(0, Math.min(100, job.percent ?? 0));
    const line = [
      job.totalBytes ? `${bytes(job.downloadedBytes)} / ${bytes(job.totalBytes)}` : bytes(job.downloadedBytes),
      job.speed ? `${bytes(job.speed)}/s` : "",
      job.eta ? `${clock(job.eta)} left` : ""
    ].filter(Boolean).join(" \u2022 ");
    body.innerHTML = `<p class="t">${escapeHtml(job.title)}</p><p class="sub">${escapeHtml(job.label)}</p>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent.toFixed(0)}">
      <i style="width:${percent.toFixed(1)}%"></i></div>
    <p class="note" aria-live="polite">${percent.toFixed(0)}% ${escapeHtml(line ? "\u2022 " + line : "")}</p>`;
    const foot = document.createElement("div");
    foot.className = "foot";
    foot.innerHTML = `<span class="note"></span><span><button class="ghost" data-hide>Hide</button> <button class="go" data-cancel>Cancel</button></span>`;
    body.parentElement.append(foot);
    foot.querySelector("[data-hide]").addEventListener("click", closeDialog);
    foot.querySelector("[data-cancel]").addEventListener("click", () => {
      if (state.jobId) void send({ type: "cancel", jobId: state.jobId });
    });
  }
  function showDone(job) {
    const body = card("Download completed");
    body.innerHTML = `<p class="t">${escapeHtml(job.filepath?.split(/[\\/]/).pop() ?? job.title)}</p>
    <p class="sub">Saved.</p>`;
    const foot = document.createElement("div");
    foot.className = "foot";
    foot.innerHTML = `<span></span><span><button class="ghost" data-folder>Open folder</button> <button class="go" data-close>Close</button></span>`;
    body.parentElement.append(foot);
    foot.querySelector("[data-close]").addEventListener("click", closeDialog);
    foot.querySelector("[data-folder]").addEventListener("click", () => void send({ type: "openFolder", path: job.filepath ?? "" }));
  }
  var FRIENDLY = {
    NO_HELPER: { title: "Setup required", text: "The local helper is not installed.", action: "Set up" },
    NO_YTDLP: { title: "yt-dlp is not installed", text: "Install yt-dlp, then test the setup in settings.", action: "Set up yt-dlp" },
    FFMPEG_MISSING: { title: "FFmpeg is required", text: "Try M4A or a quality that already includes audio.", action: "Settings" },
    VIDEO_UNAVAILABLE: { title: "Video unavailable", text: "YouTube will not serve this video." },
    AUTH_REQUIRED: { title: "Sign-in required", text: "This video is private, members-only or age-restricted." },
    FORMAT_UNAVAILABLE: { title: "Quality not available", text: "Reopen the dialog to reload the list." },
    NETWORK_ERROR: { title: "Network problem", text: "The connection dropped during the download." }
  };
  function showError(error) {
    const friendly = FRIENDLY[error.code] ?? { title: "Download failed", text: error.message };
    const body = card(friendly.title);
    body.innerHTML = `<p class="sub">${escapeHtml(friendly.text)}</p>
    ${error.detail ? `<button class="ghost" data-det>Details</button><div class="det" hidden>${escapeHtml(error.detail)}</div>` : ""}`;
    const foot = document.createElement("div");
    foot.className = "foot";
    foot.innerHTML = `<span></span><span>${friendly.action ? `<button class="ghost" data-settings>${escapeHtml(friendly.action)}</button> ` : ""}<button class="go" data-close>Close</button></span>`;
    body.parentElement.append(foot);
    body.querySelector("[data-det]")?.addEventListener("click", () => {
      const box = body.querySelector(".det");
      box.hidden = !box.hidden;
    });
    foot.querySelector("[data-close]").addEventListener("click", closeDialog);
    foot.querySelector("[data-settings]")?.addEventListener("click", () => {
      void send({ type: "settings" });
      closeDialog();
    });
  }
  ext.runtime.onMessage.addListener((message) => {
    if (message?.type !== "job" || !root) return void 0;
    const job = message.job;
    if (state.jobId === void 0 && state.awaitingJob) state.jobId = job.id;
    if (job.id !== state.jobId) return void 0;
    if (job.state === "completed") showDone(job);
    else if (job.state === "failed") showError(job.error ?? { code: "FAILED", message: "The download failed." });
    else if (job.state === "cancelled") closeDialog();
    else showProgress(job);
    return void 0;
  });
  window.addEventListener("yt-navigate-finish", onNavigate, true);
  window.addEventListener("popstate", onNavigate, true);
  onNavigate();
})();
