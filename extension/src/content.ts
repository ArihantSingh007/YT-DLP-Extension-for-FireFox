/**
 * Content script. Deliberately tiny: it finds the YouTube action bar, adds one
 * button, and renders a dialog in a shadow root. No yt-dlp knowledge, no format
 * parsing, no timers, no document-wide observers.
 */
import { bytes, clock, escapeHtml, ext, getSettings, send, setSettings, videoUrl,
  type Choice, type Deps, type Job, type Settings, type VideoInfo } from "./shared";
import { audioChoices, videoChoices } from "./formats";

const BUTTON_ID = "ytdlp-bridge-btn";
const HOST_ID = "ytdlp-bridge-ui";

const WATCH_ANCHORS = ["ytd-watch-metadata #top-level-buttons-computed", "#top-level-buttons-computed", "ytd-watch-metadata #actions"];
const SHORTS_ANCHORS = ["ytd-reel-video-renderer[is-active] #actions", "#shorts-container #actions"];

let observer: MutationObserver | null = null;
let currentId: string | null = null;

// ------------------------------------------------------------------- button

function anchorFor(shorts: boolean): HTMLElement | null {
  for (const selector of shorts ? SHORTS_ANCHORS : WATCH_ANCHORS) {
    const node = document.querySelector<HTMLElement>(selector);
    if (node?.isConnected) return node;
  }
  return null;
}

function makeButton(shorts: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.title = "Download with yt-dlp";
  button.setAttribute("aria-label", "Download with yt-dlp");
  button.textContent = "Download";
  // Inline styles only: nothing is added to YouTube's stylesheet.
  button.style.cssText =
    "display:inline-flex;align-items:center;height:36px;padding:0 14px;margin-left:8px;border:0;cursor:pointer;" +
    "border-radius:18px;font:500 14px/36px Roboto,'Segoe UI',system-ui,sans-serif;" +
    "background:var(--yt-spec-badge-chip-background,rgba(128,128,128,.18));color:var(--yt-spec-text-primary,inherit)" +
    (shorts ? ";margin:0;width:48px;height:48px;padding:0;border-radius:50%;font-size:0" : "");
  if (shorts) button.textContent = "⭳";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openDialog();
  });
  return button;
}

function place(): boolean {
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

/** Watch the smallest container that could contain the action bar, and stop as
 * soon as the button is placed. Idle cost while watching YouTube: zero. */
function ensureButton(): void {
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

function onNavigate(): void {
  const target = videoUrl(location.href);
  if (target?.id !== currentId) {
    currentId = target?.id ?? null;
    closeDialog();
  }
  ensureButton();
}

// ------------------------------------------------------------------- dialog

const CSS = `
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

let root: ShadowRoot | null = null;
let state: {
  info?: VideoInfo; deps?: Deps; settings?: Settings; mode?: "video" | "audio";
  choices?: Choice[]; pick?: Choice; jobId?: string; awaitingJob?: boolean; dir?: string;
} = {};

function card(title: string): HTMLElement {
  root!.querySelector(".back")?.remove();
  const back = document.createElement("div");
  back.className = "back";
  back.addEventListener("mousedown", (e) => { if (e.target === back) closeDialog(); });
  back.innerHTML = `<div class="card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
    <div class="head"><h2>${escapeHtml(title)}</h2><button class="x" aria-label="Close">×</button></div>
    <div class="body"></div></div>`;
  back.querySelector(".x")!.addEventListener("click", closeDialog);
  root!.append(back);
  (back.querySelector(".x") as HTMLElement).focus();
  return back.querySelector(".body") as HTMLElement;
}

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape" && root) { event.preventDefault(); closeDialog(); }
}

function closeDialog(): void {
  document.getElementById(HOST_ID)?.remove();
  document.removeEventListener("keydown", onKey, true);
  root = null;
  state = {};
}

async function openDialog(): Promise<void> {
  const target = videoUrl(location.href);   // resolved at click time, never cached
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

  card("Download").innerHTML = `<p class="sub">Reading available qualities…</p>`;

  const [depsReply, infoReply] = await Promise.all([
    send<Deps>({ type: "deps" }),
    send<VideoInfo>({ type: "info", url: target.url }),
  ]);
  if (!root) return;                                  // closed while loading
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

function header(): string {
  const i = state.info!;
  return `<div class="video">
    ${i.thumbnail ? `<img alt="" src="${escapeHtml(safeUrl(i.thumbnail))}">` : `<img alt="">`}
    <div><p class="t">${escapeHtml(i.title)}</p>
      <p class="sub">${escapeHtml([i.uploader, clock(i.duration), i.isLive ? "Live" : ""].filter(Boolean).join(" • "))}</p></div>
  </div>`;
}

function safeUrl(value: string): string {
  try { const u = new URL(value); return u.protocol === "https:" ? u.toString() : ""; } catch { return ""; }
}

function showModes(): void {
  const body = card("Download");
  body.innerHTML = `${header()}<p class="label">Download as</p>
    <div class="pair"><button class="big" data-m="video">Video</button><button class="big" data-m="audio">Music</button></div>`;
  body.querySelectorAll<HTMLButtonElement>("[data-m]").forEach((button) =>
    button.addEventListener("click", () => showChoices(button.dataset.m as "video" | "audio")));
}

function showChoices(mode: "video" | "audio"): void {
  const settings = state.settings!;
  state.mode = mode;
  void setSettings({ lastMode: mode });
  const info = state.info!;
  state.choices = mode === "video"
    ? videoChoices(info.formats, info.duration ?? null, settings)
    : audioChoices(info.formats, info.duration ?? null, settings);
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
  const list = body.querySelector(".list")!;
  for (const choice of state.choices) {
    const option = document.createElement("button");
    option.className = "opt";
    option.type = "button";
    option.setAttribute("role", "radio");
    option.setAttribute("aria-checked", String(choice.key === state.pick?.key));
    option.innerHTML = `<span class="name">${escapeHtml(choice.label)}</span><span class="note">${escapeHtml(choice.note)}</span>`;
    option.addEventListener("click", () => { state.pick = choice; showChoices(mode); });
    list.append(option);
  }
  body.querySelector<HTMLInputElement>("#dir")?.addEventListener("change", (e) => {
    state.dir = (e.target as HTMLInputElement).value.trim();
  });

  const foot = document.createElement("div");
  foot.className = "foot";
  const missing = state.pick?.needsFfmpeg && !state.deps?.ffmpeg.found;
  foot.innerHTML = `<span class="note">${missing ? "FFmpeg is required for this choice." : ""}</span>
    <span><button class="ghost" data-back>Back</button> <button class="go" ${missing ? "disabled" : ""}>Download</button></span>`;
  body.parentElement!.append(foot);
  foot.querySelector("[data-back]")!.addEventListener("click", showModes);
  foot.querySelector(".go")!.addEventListener("click", () => void startDownload());
}

async function startDownload(): Promise<void> {
  const { pick, info, mode } = state;
  if (!pick || !info) return;
  // Events can arrive before the reply carrying the job id, so adopt the first
  // job we hear about while a start is in flight.
  state.awaitingJob = true;
  showProgress({ id: "", state: "queued", title: info.title, label: pick.label, percent: 0, stage: "Starting" });
  const reply = await send<Job>({
    type: "download",
    url: location.href,
    mode,
    format: pick.selector,
    audioFormat: pick.audioFormat,
    outputDirectory: state.dir || "",
    title: info.title,
    label: pick.label,
  });
  if (!reply.ok) {
    state.awaitingJob = false;
    return showError(reply.error);
  }
  state.jobId = reply.data.id;
  state.awaitingJob = false;
}

function showProgress(job: Job): void {
  const body = card(job.stage ?? "Downloading");
  const percent = Math.max(0, Math.min(100, job.percent ?? 0));
  const line = [
    job.totalBytes ? `${bytes(job.downloadedBytes)} / ${bytes(job.totalBytes)}` : bytes(job.downloadedBytes),
    job.speed ? `${bytes(job.speed)}/s` : "",
    job.eta ? `${clock(job.eta)} left` : "",
  ].filter(Boolean).join(" • ");
  body.innerHTML = `<p class="t">${escapeHtml(job.title)}</p><p class="sub">${escapeHtml(job.label)}</p>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent.toFixed(0)}">
      <i style="width:${percent.toFixed(1)}%"></i></div>
    <p class="note" aria-live="polite">${percent.toFixed(0)}% ${escapeHtml(line ? "• " + line : "")}</p>`;
  const foot = document.createElement("div");
  foot.className = "foot";
  foot.innerHTML = `<span class="note"></span><span><button class="ghost" data-hide>Hide</button> <button class="go" data-cancel>Cancel</button></span>`;
  body.parentElement!.append(foot);
  foot.querySelector("[data-hide]")!.addEventListener("click", closeDialog);
  foot.querySelector("[data-cancel]")!.addEventListener("click", () => {
    if (state.jobId) void send({ type: "cancel", jobId: state.jobId });
  });
}

function showDone(job: Job): void {
  const body = card("Download completed");
  body.innerHTML = `<p class="t">${escapeHtml(job.filepath?.split(/[\\/]/).pop() ?? job.title)}</p>
    <p class="sub">Saved.</p>`;
  const foot = document.createElement("div");
  foot.className = "foot";
  foot.innerHTML = `<span></span><span><button class="ghost" data-folder>Open folder</button> <button class="go" data-close>Close</button></span>`;
  body.parentElement!.append(foot);
  foot.querySelector("[data-close]")!.addEventListener("click", closeDialog);
  foot.querySelector("[data-folder]")!.addEventListener("click", () =>
    void send({ type: "openFolder", path: job.filepath ?? "" }));
}

const FRIENDLY: Record<string, { title: string; text: string; action?: string }> = {
  NO_HELPER: { title: "Setup required", text: "The local helper is not installed.", action: "Set up" },
  NO_YTDLP: { title: "yt-dlp is not installed", text: "Install yt-dlp, then test the setup in settings.", action: "Set up yt-dlp" },
  FFMPEG_MISSING: { title: "FFmpeg is required", text: "Try M4A or a quality that already includes audio.", action: "Settings" },
  VIDEO_UNAVAILABLE: { title: "Video unavailable", text: "YouTube will not serve this video." },
  AUTH_REQUIRED: { title: "Sign-in required", text: "This video is private, members-only or age-restricted." },
  FORMAT_UNAVAILABLE: { title: "Quality not available", text: "Reopen the dialog to reload the list." },
  NETWORK_ERROR: { title: "Network problem", text: "The connection dropped during the download." },
};

function showError(error: { code: string; message: string; detail?: string }): void {
  const friendly = FRIENDLY[error.code] ?? { title: "Download failed", text: error.message };
  const body = card(friendly.title);
  body.innerHTML = `<p class="sub">${escapeHtml(friendly.text)}</p>
    ${error.detail ? `<button class="ghost" data-det>Details</button><div class="det" hidden>${escapeHtml(error.detail)}</div>` : ""}`;
  const foot = document.createElement("div");
  foot.className = "foot";
  foot.innerHTML = `<span></span><span>${friendly.action ? `<button class="ghost" data-settings>${escapeHtml(friendly.action)}</button> ` : ""}<button class="go" data-close>Close</button></span>`;
  body.parentElement!.append(foot);
  body.querySelector("[data-det]")?.addEventListener("click", () => {
    const box = body.querySelector<HTMLElement>(".det")!;
    box.hidden = !box.hidden;
  });
  foot.querySelector("[data-close]")!.addEventListener("click", closeDialog);
  foot.querySelector("[data-settings]")?.addEventListener("click", () => { void send({ type: "settings" }); closeDialog(); });
}

// ------------------------------------------------------------------- wiring

ext.runtime.onMessage.addListener((message: any) => {
  if (message?.type !== "job" || !root) return undefined;
  const job: Job = message.job;
  if (state.jobId === undefined && state.awaitingJob) state.jobId = job.id;
  if (job.id !== state.jobId) return undefined;
  if (job.state === "completed") showDone(job);
  else if (job.state === "failed") showError(job.error ?? { code: "FAILED", message: "The download failed." });
  else if (job.state === "cancelled") closeDialog();
  else showProgress(job);
  return undefined;
});

window.addEventListener("yt-navigate-finish", onNavigate, true);
window.addEventListener("popstate", onNavigate, true);
onNavigate();
