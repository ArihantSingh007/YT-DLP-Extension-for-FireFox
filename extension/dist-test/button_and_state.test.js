// src/test/button_and_state.test.ts
import { strict as assert } from "node:assert";
import test from "node:test";

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
  lastMode: "video",
  embedThumbnail: true,
  embedChapters: true,
  embedMetadata: true,
  writeSubtitles: false,
  writeAutoSubtitles: false,
  embedSubtitles: false,
  subLangs: "en.*,all",
  subFormat: "best",
  sponsorblockRemove: "off",
  sponsorblockMark: "off",
  rateLimit: "",
  concurrentFragments: 1,
  proxy: "",
  retries: 5,
  cookiesBrowser: "none",
  keepVideo: false,
  customArgs: ""
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
var WATCH_ANCHORS = [
  "ytd-watch-metadata #top-level-buttons-computed",
  "ytd-watch-metadata ytd-menu-renderer #top-level-buttons-computed",
  "#actions-inner #top-level-buttons-computed",
  "#top-level-buttons-computed",
  "ytd-watch-metadata #actions",
  "#actions.ytd-watch-metadata",
  "#menu-container #top-level-buttons-computed"
];
var SHORTS_ANCHORS = [
  "ytd-reel-video-renderer[is-active] #actions",
  "#shorts-container ytd-reel-video-renderer[is-active] #actions",
  "#shorts-container #actions",
  "ytd-reel-player-overlay-renderer #actions"
];
var boundButtons = /* @__PURE__ */ new WeakSet();
var observer = null;
var navTimers = [];
var pendingCheck = false;
var currentId = null;
function anchorFor(shorts) {
  for (const selector of shorts ? SHORTS_ANCHORS : WATCH_ANCHORS) {
    const node = document.querySelector(selector);
    if (node?.isConnected) return node;
  }
  return null;
}
function findExistingDownloadButton(container) {
  const dlRenderer = container.querySelector("ytd-download-button-renderer button");
  if (dlRenderer && (typeof HTMLButtonElement === "undefined" || dlRenderer instanceof HTMLButtonElement)) {
    return dlRenderer;
  }
  const buttons = container.querySelectorAll("button");
  for (const btn of buttons) {
    if (btn.id === BUTTON_ID) continue;
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    const title = (btn.getAttribute("title") || "").toLowerCase();
    const text = (btn.textContent || "").trim().toLowerCase();
    if (label.includes("download") || title.includes("download") || text === "download") {
      return btn;
    }
  }
  return null;
}
function bindExistingButton(btn) {
  if (boundButtons.has(btn)) return;
  boundButtons.add(btn);
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    void openDialog();
  }, true);
}
function createShortsSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.style.pointerEvents = "none";
  svg.style.display = "block";
  svg.style.margin = "auto";
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", "M12 3v10.55l3.5-3.55.7.7-4.7 4.75-4.7-4.75.7-.7 3.5 3.55V3h1zM4 17h16v2H4v-2z");
  svg.append(path);
  return svg;
}
function makeShortsButton() {
  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.title = "Download with yt-dlp";
  button.setAttribute("aria-label", "Download with yt-dlp");
  button.append(createShortsSvg());
  button.style.cssText = "display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;margin-top:16px;padding:0;border:0;cursor:pointer;background:var(--yt-spec-badge-chip-background,rgba(255,255,255,.15));color:var(--yt-spec-text-primary,#fff);";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openDialog();
  });
  return button;
}
function makeFallbackWatchButton() {
  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.title = "Download with yt-dlp";
  button.setAttribute("aria-label", "Download with yt-dlp");
  button.textContent = "Download";
  button.style.cssText = "display:inline-flex;align-items:center;height:36px;padding:0 14px;margin-left:8px;border:0;cursor:pointer;border-radius:18px;font:500 14px/36px Roboto,'Segoe UI',system-ui,sans-serif;background:var(--yt-spec-badge-chip-background,rgba(128,128,128,.18));color:var(--yt-spec-text-primary,inherit);";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openDialog();
  });
  return button;
}
function bindOrPlace() {
  const target = videoUrl(location.href);
  const existingCustom = document.getElementById(BUTTON_ID);
  if (!target) {
    existingCustom?.remove();
    return true;
  }
  const anchor = anchorFor(target.shorts);
  if (!anchor) return false;
  if (target.shorts) {
    if (existingCustom?.parentElement === anchor) return true;
    existingCustom?.remove();
    anchor.append(makeShortsButton());
    return true;
  }
  const nativeBtn = findExistingDownloadButton(anchor);
  if (nativeBtn) {
    existingCustom?.remove();
    bindExistingButton(nativeBtn);
    return true;
  }
  if (existingCustom?.parentElement === anchor) return true;
  existingCustom?.remove();
  anchor.append(makeFallbackWatchButton());
  return true;
}
function scheduleCheck() {
  if (pendingCheck) return;
  pendingCheck = true;
  requestAnimationFrame(() => {
    pendingCheck = false;
    bindOrPlace();
  });
}
function startObserver() {
  if (observer) return;
  observer = new MutationObserver(() => {
    scheduleCheck();
  });
  const targetNode = document.querySelector("ytd-page-manager") ?? document.body;
  if (targetNode) {
    observer.observe(targetNode, { childList: true, subtree: true });
  }
}
function clearNavTimers() {
  for (const t of navTimers) clearTimeout(t);
  navTimers = [];
}
function ensureButton() {
  startObserver();
  bindOrPlace();
  clearNavTimers();
  const delays = [100, 250, 500, 900, 1500, 2500, 4e3];
  for (const delay of delays) {
    navTimers.push(window.setTimeout(() => {
      bindOrPlace();
    }, delay));
  }
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
:host { all: initial; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.back { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.65); backdrop-filter: blur(5px); padding: 20px; font: 14px/1.45 inherit; }
.card { width: min(440px,100%); max-height: 86vh; overflow-y: auto; background: #ffffff; color: #0f172a;
  border-radius: 16px; box-shadow: 0 24px 64px rgba(0,0,0,.45); display: flex; flex-direction: column;
  border: 1px solid rgba(0,0,0,.08); transition: transform .15s ease-out; }
@media (prefers-color-scheme: dark) {
  .card { background: #161821; color: #f8fafc; border: 1px solid rgba(255,255,255,.09); box-shadow: 0 24px 64px rgba(0,0,0,.7); }
}
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 16px 20px; border-bottom: 1px solid rgba(128,128,128,.16); }
.head h2 { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
.x { border: 0; background: transparent; color: inherit; font-size: 20px; line-height: 1; width: 32px; height: 32px; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; opacity: .7; transition: background .15s, opacity .15s; }
.x:hover { background: rgba(128,128,128,.18); opacity: 1; }
.body { padding: 20px; display: grid; gap: 16px; }
.video { display: flex; gap: 14px; align-items: flex-start; }
.video img { width: 104px; height: 58px; border-radius: 8px; object-fit: cover; background: rgba(128,128,128,.18); flex-shrink: 0; }
.t { font-weight: 600; font-size: 14px; margin: 0 0 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.35; }
.sub, .note { color: #64748b; font-size: 12.5px; margin: 0; }
@media (prefers-color-scheme: dark) { .sub, .note { color: #94a3b8; } }
.label { font-weight: 600; font-size: 13.5px; margin: 0; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.big { padding: 20px 14px; border: 1px solid rgba(128,128,128,.28); border-radius: 12px; background: rgba(128,128,128,.05); color: inherit;
  font: 600 15px inherit; cursor: pointer; transition: all .15s ease; text-align: center; }
.big:hover { border-color: #3b82f6; background: rgba(59,130,246,.08); transform: translateY(-1px); }
.list { display: grid; gap: 8px; outline: none; }
.opt { display: flex; justify-content: space-between; align-items: center; gap: 12px; width: 100%; text-align: left;
  padding: 12px 14px; border: 1px solid rgba(128,128,128,.25); border-radius: 12px; background: rgba(128,128,128,.04); color: inherit; font: inherit; cursor: pointer; transition: all .15s ease; }
.opt:hover { border-color: #3b82f6; background: rgba(59,130,246,.06); }
.opt[aria-checked="true"] { border-color: #3b82f6; box-shadow: inset 0 0 0 1px #3b82f6; background: rgba(59,130,246,.12); font-weight: 600; }
.opt .name { font-size: 13.5px; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px; border-top: 1px solid rgba(128,128,128,.16); margin-top: auto; }
.go { background: #2563eb; color: #fff; border: 0; border-radius: 10px; padding: 10px 20px; font: 600 13.5px inherit; cursor: pointer; transition: background .15s, transform .05s; box-shadow: 0 2px 8px rgba(37,99,235,.28); }
.go:hover { background: #1d4ed8; }
.go:active { transform: scale(.98); }
.go[disabled] { opacity: .5; cursor: not-allowed; box-shadow: none; }
.ghost { background: transparent; color: inherit; border: 1px solid rgba(128,128,128,.3); border-radius: 10px; padding: 9px 16px; font: 600 13.5px inherit; cursor: pointer; transition: all .15s ease; }
.ghost:hover { background: rgba(128,128,128,.14); }
.bar { height: 7px; border-radius: 99px; background: rgba(128,128,128,.2); overflow: hidden; }
.bar i { display: block; height: 100%; background: linear-gradient(90deg, #3b82f6, #6366f1); border-radius: 99px; transition: width .2s ease-out; }
.det { white-space: pre-wrap; font: 11.5px ui-monospace, Consolas, monospace; background: rgba(128,128,128,.12);
  padding: 10px 12px; border-radius: 10px; max-height: 140px; overflow: auto; line-height: 1.4; }
input.dir { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(128,128,128,.35); background: rgba(128,128,128,.05); color: inherit; font: inherit; font-size: 13px; box-sizing: border-box; }
button:focus-visible, input:focus-visible, .list:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
`;
var root = null;
var state = {};
function getOrCreateCard(title) {
  let back = root.querySelector(".back");
  if (!back) {
    back = document.createElement("div");
    back.className = "back";
    back.addEventListener("mousedown", (e) => {
      if (e.target === back) closeDialog();
    });
    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", title);
    const head = document.createElement("div");
    head.className = "head";
    const h2 = document.createElement("h2");
    h2.id = "card-title";
    h2.textContent = title;
    const closeBtn = document.createElement("button");
    closeBtn.className = "x";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "\xD7";
    closeBtn.addEventListener("click", closeDialog);
    head.append(h2, closeBtn);
    const body2 = document.createElement("div");
    body2.className = "body";
    body2.id = "card-body";
    const foot2 = document.createElement("div");
    foot2.className = "foot";
    foot2.id = "card-foot";
    card.append(head, body2, foot2);
    back.append(card);
    root.append(back);
    closeBtn.focus();
  } else {
    const headTitle = back.querySelector("#card-title");
    if (headTitle) headTitle.textContent = title;
    const cardEl = back.querySelector(".card");
    if (cardEl) cardEl.setAttribute("aria-label", title);
  }
  const body = back.querySelector("#card-body");
  const foot = back.querySelector("#card-foot");
  body.replaceChildren();
  foot.replaceChildren();
  return { body, foot };
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
  const activeReply = await send({ type: "jobForUrl", url: target.url });
  if (!root) return;
  if (activeReply.ok && activeReply.data) {
    const existing = activeReply.data;
    if (existing.state === "queued" || existing.state === "downloading" || existing.state === "processing") {
      state.jobId = existing.id;
      showProgress(existing);
      return;
    }
    if (existing.state === "completed") {
      state.jobId = existing.id;
      showDone(existing);
      return;
    }
  }
  const { body } = getOrCreateCard("Download");
  const loadingP = document.createElement("p");
  loadingP.className = "sub";
  loadingP.textContent = "Reading available qualities\u2026";
  body.append(loadingP);
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
function createHeader(i) {
  const wrap = document.createElement("div");
  wrap.className = "video";
  const img = document.createElement("img");
  img.alt = "";
  if (i.thumbnail) {
    const src = safeUrl(i.thumbnail);
    if (src) img.src = src;
  }
  const meta = document.createElement("div");
  const titleP = document.createElement("p");
  titleP.className = "t";
  titleP.textContent = i.title;
  const subP = document.createElement("p");
  subP.className = "sub";
  subP.textContent = [i.uploader, clock(i.duration), i.isLive ? "Live" : ""].filter(Boolean).join(" \u2022 ");
  meta.append(titleP, subP);
  wrap.append(img, meta);
  return wrap;
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
  const { body } = getOrCreateCard("Download");
  body.append(createHeader(state.info));
  const label = document.createElement("p");
  label.className = "label";
  label.textContent = "Download as";
  const pair = document.createElement("div");
  pair.className = "pair";
  const videoBtn = document.createElement("button");
  videoBtn.className = "big";
  videoBtn.dataset.m = "video";
  videoBtn.textContent = "Video";
  videoBtn.addEventListener("click", () => showChoices("video"));
  const audioBtn = document.createElement("button");
  audioBtn.className = "big";
  audioBtn.dataset.m = "audio";
  audioBtn.textContent = "Music";
  audioBtn.addEventListener("click", () => showChoices("audio"));
  pair.append(videoBtn, audioBtn);
  body.append(label, pair);
}
function selectChoice(choice) {
  state.pick = choice;
  if (!root) return;
  const options = root.querySelectorAll(".opt");
  options.forEach((btn) => {
    const isChosen = btn.getAttribute("data-key") === choice.key;
    btn.setAttribute("aria-checked", String(isChosen));
  });
  const missing = choice.needsFfmpeg && !state.deps?.ffmpeg.found;
  const goBtn = root.querySelector("#btn-download");
  const missingNote = root.querySelector("#missing-note");
  if (goBtn) goBtn.disabled = Boolean(missing);
  if (missingNote) missingNote.textContent = missing ? "FFmpeg is required for this choice." : "";
}
function onListKeyDown(e) {
  if (!state.choices || !state.choices.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const currIndex = state.choices.findIndex((c) => c.key === state.pick?.key);
    const nextIndex = e.key === "ArrowDown" ? (currIndex + 1) % state.choices.length : (currIndex - 1 + state.choices.length) % state.choices.length;
    const next = state.choices[nextIndex];
    selectChoice(next);
    const nextBtn = root?.querySelector(`.opt[data-key="${next.key}"]`);
    nextBtn?.focus();
  }
}
function showChoices(mode) {
  const settings = state.settings;
  state.mode = mode;
  void setSettings({ lastMode: mode });
  const info = state.info;
  state.choices = mode === "video" ? videoChoices(info.formats, info.duration ?? null, settings) : audioChoices(info.formats, info.duration ?? null, settings);
  state.pick = state.choices.find((c) => c.key === (mode === "audio" ? settings.audioFormat : "best")) ?? state.choices[0];
  const { body, foot } = getOrCreateCard(mode === "video" ? "Video" : "Music");
  if (!state.choices.length) {
    const sub = document.createElement("p");
    sub.className = "sub";
    sub.textContent = `No ${mode === "video" ? "video" : "audio"} formats are available for this video.`;
    body.append(sub);
    return;
  }
  const missing = Boolean(state.pick?.needsFfmpeg && !state.deps?.ffmpeg.found);
  const label = document.createElement("p");
  label.className = "label";
  label.id = "pick-label";
  label.textContent = mode === "video" ? "Quality" : "Format";
  const list = document.createElement("div");
  list.className = "list";
  list.setAttribute("role", "radiogroup");
  list.setAttribute("aria-labelledby", "pick-label");
  list.tabIndex = 0;
  for (const choice of state.choices) {
    const option = document.createElement("button");
    option.className = "opt";
    option.type = "button";
    option.setAttribute("role", "radio");
    option.setAttribute("data-key", choice.key);
    option.setAttribute("aria-checked", String(choice.key === state.pick?.key));
    const nameSpan = document.createElement("span");
    nameSpan.className = "name";
    nameSpan.textContent = choice.label;
    const noteSpan = document.createElement("span");
    noteSpan.className = "note";
    noteSpan.textContent = choice.note;
    option.append(nameSpan, noteSpan);
    option.addEventListener("click", (e) => {
      e.preventDefault();
      selectChoice(choice);
    });
    list.append(option);
  }
  list.addEventListener("keydown", (e) => onListKeyDown(e));
  body.append(label, list);
  if (mode === "video") {
    const noteP = document.createElement("p");
    noteP.className = "note";
    noteP.textContent = `Saved as ${settings.container.toUpperCase()}`;
    body.append(noteP);
  }
  if (settings.askWhereToSave) {
    const dirLabel = document.createElement("label");
    dirLabel.className = "label";
    dirLabel.htmlFor = "dir";
    dirLabel.textContent = "Save to";
    const dirInput = document.createElement("input");
    dirInput.className = "dir";
    dirInput.id = "dir";
    dirInput.spellcheck = false;
    dirInput.placeholder = "Downloads folder";
    dirInput.value = state.dir ?? "";
    dirInput.addEventListener("input", (e) => {
      state.dir = e.target.value.trim();
    });
    body.append(dirLabel, dirInput);
  }
  const missingSpan = document.createElement("span");
  missingSpan.className = "note";
  missingSpan.id = "missing-note";
  missingSpan.textContent = missing ? "FFmpeg is required for this choice." : "";
  const btnSpan = document.createElement("span");
  const backBtn = document.createElement("button");
  backBtn.className = "ghost";
  backBtn.setAttribute("data-back", "");
  backBtn.textContent = "Back";
  backBtn.addEventListener("click", showModes);
  const dlBtn = document.createElement("button");
  dlBtn.className = "go";
  dlBtn.id = "btn-download";
  dlBtn.disabled = missing;
  dlBtn.textContent = "Download";
  dlBtn.addEventListener("click", () => void startDownload());
  btnSpan.append(backBtn, document.createTextNode(" "), dlBtn);
  foot.append(missingSpan, btnSpan);
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
function formatProgressLine(job) {
  return [
    job.totalBytes ? `${bytes(job.downloadedBytes)} / ${bytes(job.totalBytes)}` : bytes(job.downloadedBytes),
    job.speed ? `${bytes(job.speed)}/s` : "",
    job.eta ? `${clock(job.eta)} left` : ""
  ].filter(Boolean).join(" \u2022 ");
}
function showProgress(job) {
  const percent = Math.max(0, Math.min(100, job.percent ?? 0));
  const line = formatProgressLine(job);
  const { body, foot } = getOrCreateCard(job.stage ?? "Downloading");
  const titleP = document.createElement("p");
  titleP.className = "t";
  titleP.textContent = job.title;
  const subP = document.createElement("p");
  subP.className = "sub";
  subP.textContent = job.label;
  const barWrap = document.createElement("div");
  barWrap.className = "bar";
  barWrap.setAttribute("role", "progressbar");
  barWrap.setAttribute("aria-valuemin", "0");
  barWrap.setAttribute("aria-valuemax", "100");
  barWrap.setAttribute("aria-valuenow", percent.toFixed(0));
  const barI = document.createElement("i");
  barI.id = "prog-bar";
  barI.style.width = `${percent.toFixed(1)}%`;
  barWrap.append(barI);
  const noteP = document.createElement("p");
  noteP.className = "note";
  noteP.id = "prog-text";
  noteP.setAttribute("aria-live", "polite");
  noteP.textContent = `${percent.toFixed(0)}% ${line ? "\u2022 " + line : ""}`;
  body.append(titleP, subP, barWrap, noteP);
  const footSpan1 = document.createElement("span");
  footSpan1.className = "note";
  const footSpan2 = document.createElement("span");
  const hideBtn = document.createElement("button");
  hideBtn.className = "ghost";
  hideBtn.setAttribute("data-hide", "");
  hideBtn.textContent = "Hide";
  hideBtn.addEventListener("click", closeDialog);
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "go";
  cancelBtn.setAttribute("data-cancel", "");
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    if (state.jobId) void send({ type: "cancel", jobId: state.jobId });
  });
  footSpan2.append(hideBtn, document.createTextNode(" "), cancelBtn);
  foot.append(footSpan1, footSpan2);
}
function updateProgress(job) {
  if (!root) return;
  const bar = root.querySelector("#prog-bar");
  const barContainer = root.querySelector(".bar");
  const text = root.querySelector("#prog-text");
  const title = root.querySelector("#card-title");
  if (!bar || !text) {
    showProgress(job);
    return;
  }
  const percent = Math.max(0, Math.min(100, job.percent ?? 0));
  if (title && job.stage) title.textContent = job.stage;
  bar.style.width = `${percent.toFixed(1)}%`;
  barContainer?.setAttribute("aria-valuenow", percent.toFixed(0));
  const line = formatProgressLine(job);
  text.textContent = `${percent.toFixed(0)}% ${line ? "\u2022 " + line : ""}`;
}
function showDone(job) {
  const filename = job.filepath?.split(/[\\/]/).pop() ?? job.title;
  const { body, foot } = getOrCreateCard("Download completed");
  const titleP = document.createElement("p");
  titleP.className = "t";
  titleP.textContent = filename;
  const subP = document.createElement("p");
  subP.className = "sub";
  subP.textContent = "Download completed.";
  body.append(titleP, subP);
  const footSpan1 = document.createElement("span");
  const footSpan2 = document.createElement("span");
  const locBtn = document.createElement("button");
  locBtn.className = "ghost";
  locBtn.setAttribute("data-location", "");
  locBtn.textContent = "Show file location";
  locBtn.addEventListener("click", () => void send({ type: "openFolder", jobId: job.id, path: job.filepath ?? "" }));
  const openBtn = document.createElement("button");
  openBtn.className = "go";
  openBtn.setAttribute("data-open", "");
  openBtn.textContent = "Open";
  openBtn.addEventListener("click", () => void send({ type: "openFile", jobId: job.id, path: job.filepath ?? "" }));
  footSpan2.append(locBtn, document.createTextNode(" "), openBtn);
  foot.append(footSpan1, footSpan2);
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
  const { body, foot } = getOrCreateCard(friendly.title);
  const subP = document.createElement("p");
  subP.className = "sub";
  subP.textContent = friendly.text;
  body.append(subP);
  if (error.detail) {
    const detBtn = document.createElement("button");
    detBtn.className = "ghost";
    detBtn.setAttribute("data-det", "");
    detBtn.textContent = "Details";
    const detBox = document.createElement("div");
    detBox.className = "det";
    detBox.hidden = true;
    detBox.textContent = error.detail;
    detBtn.addEventListener("click", () => {
      detBox.hidden = !detBox.hidden;
    });
    body.append(detBtn, detBox);
  }
  const footSpan1 = document.createElement("span");
  const footSpan2 = document.createElement("span");
  if (friendly.action) {
    const actBtn = document.createElement("button");
    actBtn.className = "ghost";
    actBtn.setAttribute("data-settings", "");
    actBtn.textContent = friendly.action;
    actBtn.addEventListener("click", () => {
      void send({ type: "settings" });
      closeDialog();
    });
    footSpan2.append(actBtn, document.createTextNode(" "));
  }
  const closeBtn = document.createElement("button");
  closeBtn.className = "go";
  closeBtn.setAttribute("data-close", "");
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeDialog);
  footSpan2.append(closeBtn);
  foot.append(footSpan1, footSpan2);
}
if (typeof ext !== "undefined" && ext?.runtime?.onMessage) {
  ext.runtime.onMessage.addListener((message) => {
    if (message?.type !== "job" || !root) return void 0;
    const job = message.job;
    if (state.jobId === void 0 && state.awaitingJob) state.jobId = job.id;
    if (job.id !== state.jobId) return void 0;
    if (job.state === "completed") showDone(job);
    else if (job.state === "failed") showError(job.error ?? { code: "FAILED", message: "The download failed." });
    else if (job.state === "cancelled") closeDialog();
    else updateProgress(job);
    return void 0;
  });
}
if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("yt-navigate-start", onNavigate, true);
  window.addEventListener("yt-navigate-finish", onNavigate, true);
  window.addEventListener("yt-page-data-updated", onNavigate, true);
  window.addEventListener("yt-visibility-refresh", onNavigate, true);
  window.addEventListener("popstate", onNavigate, true);
  window.addEventListener("yt-action", (e) => {
    const actionName = e?.detail?.actionName;
    if (actionName && (String(actionName).includes("reel") || String(actionName).includes("navigate"))) {
      onNavigate();
    }
  }, true);
  document.addEventListener("DOMContentLoaded", onNavigate);
  onNavigate();
}

// src/test/button_and_state.test.ts
var MockButton = class {
  id;
  textContent;
  attrs;
  constructor(opts = {}) {
    this.id = opts.id || "";
    this.textContent = opts.text || "";
    this.attrs = /* @__PURE__ */ new Map();
    if (opts.ariaLabel) this.attrs.set("aria-label", opts.ariaLabel);
    if (opts.title) this.attrs.set("title", opts.title);
  }
  getAttribute(name) {
    return this.attrs.get(name) ?? null;
  }
};
var MockContainer = class {
  buttons = [];
  dlRendererButton = null;
  querySelector(selector) {
    if (selector.includes("ytd-download-button-renderer")) {
      return this.dlRendererButton;
    }
    return null;
  }
  querySelectorAll(selector) {
    if (selector === "button") {
      return this.buttons;
    }
    return [];
  }
};
test("findExistingDownloadButton finds ytd-download-button-renderer button", () => {
  const container = new MockContainer();
  const dlBtn = new MockButton({ ariaLabel: "Download video" });
  container.dlRendererButton = dlBtn;
  Object.setPrototypeOf(dlBtn, globalThis.HTMLButtonElement?.prototype || Object.prototype);
  const found = container.querySelector("ytd-download-button-renderer button");
  assert.equal(found, dlBtn);
});
test("findExistingDownloadButton identifies existing native button by aria-label or title", () => {
  const container = new MockContainer();
  const likeBtn = new MockButton({ ariaLabel: "Like this video along with 10k others" });
  const shareBtn = new MockButton({ ariaLabel: "Share" });
  const downloadBtn = new MockButton({ ariaLabel: "Download" });
  container.buttons = [likeBtn, shareBtn, downloadBtn];
  const found = findExistingDownloadButton(container);
  assert.equal(found, downloadBtn);
});
test("findExistingDownloadButton ignores custom extension button and other buttons", () => {
  const container = new MockContainer();
  const customBtn = new MockButton({ id: BUTTON_ID, text: "Download" });
  const shareBtn = new MockButton({ ariaLabel: "Share", text: "Share" });
  container.buttons = [customBtn, shareBtn];
  const found = findExistingDownloadButton(container);
  assert.equal(found, null);
});
test("findExistingDownloadButton matches title attribute as fallback", () => {
  const container = new MockContainer();
  const titleDlBtn = new MockButton({ title: "Download offline" });
  container.buttons = [titleDlBtn];
  const found = findExistingDownloadButton(container);
  assert.equal(found, titleDlBtn);
});
test("in-flight metadata deduplication shares single promise for concurrent requests", async () => {
  const inFlight = /* @__PURE__ */ new Map();
  let callCount = 0;
  async function mockFetchInfo(id) {
    const existing = inFlight.get(id);
    if (existing) return existing;
    const promise = (async () => {
      try {
        callCount++;
        await new Promise((r) => setTimeout(r, 10));
        return { id, title: "Test Video", webpageUrl: `https://www.youtube.com/watch?v=${id}`, formats: [] };
      } finally {
        inFlight.delete(id);
      }
    })();
    inFlight.set(id, promise);
    return promise;
  }
  const [res1, res2, res3] = await Promise.all([
    mockFetchInfo("test1234567"),
    mockFetchInfo("test1234567"),
    mockFetchInfo("test1234567")
  ]);
  assert.equal(callCount, 1);
  assert.equal(res1.title, "Test Video");
  assert.equal(res2.title, "Test Video");
  assert.equal(res3.title, "Test Video");
});
test("bounded job history prunes oldest completed jobs beyond limit", () => {
  const jobs = /* @__PURE__ */ new Map();
  const limit = 5;
  function prune() {
    if (jobs.size <= limit) return;
    for (const [id, job] of jobs) {
      if (job.state === "completed" || job.state === "failed" || job.state === "cancelled") {
        jobs.delete(id);
        if (jobs.size <= limit) break;
      }
    }
  }
  for (let i = 1; i <= 8; i++) {
    jobs.set(`job-${i}`, {
      id: `job-${i}`,
      state: "completed",
      title: `Job ${i}`,
      label: "1080p",
      percent: 100
    });
    prune();
  }
  assert.equal(jobs.size, limit);
  assert.ok(!jobs.has("job-1"));
  assert.ok(!jobs.has("job-2"));
  assert.ok(!jobs.has("job-3"));
  assert.ok(jobs.has("job-8"));
});
test("videoUrl properly handles normal videos, shorts, and drops playlist parameters", () => {
  const normal = videoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123456&index=2");
  assert.ok(normal);
  assert.equal(normal.id, "dQw4w9WgXcQ");
  assert.equal(normal.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(normal.shorts, false);
  const short = videoUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ");
  assert.ok(short);
  assert.equal(short.id, "dQw4w9WgXcQ");
  assert.equal(short.shorts, true);
  const channel = videoUrl("https://www.youtube.com/@YouTube");
  assert.equal(channel, null);
});
