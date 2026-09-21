/**
 * The only code that may talk to the native host.
 *
 * Responsibilities: one lazy native port, a small metadata cache, the download
 * queue mirror, and re-validating anything that arrives from a page.
 * No timers, no polling: everything here runs in response to a message.
 */
import { ext, getSettings, videoUrl, type Deps, type Job, type VideoInfo } from "./shared";

const HOST = "com.kcgamingtech.ytdlp_bridge";
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 8;

// -------------------------------------------------------------- native port

let port: any = null;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
const jobs = new Map<string, Job>();
const tabOfJob = new Map<string, number>();
let counter = 0;

const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

function connect(): any {
  if (port) return port;
  port = ext.runtime.connectNative(HOST);              // started lazily, on first use
  port.onMessage.addListener(onNativeMessage);
  port.onDisconnect.addListener(() => {
    const reason = ext.runtime.lastError?.message ?? "The helper stopped.";
    port = null;
    for (const [, p] of pending) p.reject({ code: "NO_HELPER", message: helperMessage(), detail: reason });
    pending.clear();
    for (const job of jobs.values()) {
      if (job.state === "queued" || job.state === "downloading" || job.state === "processing") {
        update(job.id, { state: "failed", error: { code: "NO_HELPER", message: helperMessage() } });
      }
    }
  });
  return port;
}

function helperMessage(): string {
  return "The local helper is not installed or stopped responding.";
}

function request<T>(action: string, payload: Record<string, unknown> = {}, id = newId("r")): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let live: any;
    try {
      live = connect();
    } catch (cause: any) {
      reject({ code: "NO_HELPER", message: helperMessage(), detail: String(cause?.message ?? cause) });
      return;
    }
    pending.set(id, { resolve, reject });
    try {
      live.postMessage({ id, action, ...payload });
    } catch (cause: any) {
      pending.delete(id);
      reject({ code: "NO_HELPER", message: helperMessage(), detail: String(cause?.message ?? cause) });
    }
  });
}

function onNativeMessage(message: any): void {
  if (!message || typeof message !== "object") return;
  if (message.event) return onJobEvent(message);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.success) waiter.resolve(message.data ?? {});
  else waiter.reject(message.error ?? { code: "UNKNOWN", message: "The helper reported an error." });
}

const STAGES: Record<string, string> = {
  Merger: "Merging video and audio",
  ExtractAudio: "Converting audio",
  Metadata: "Writing metadata",
};

function onJobEvent(event: any): void {
  const job = jobs.get(event.id);
  if (!job) return;
  switch (event.event) {
    case "started":
      update(job.id, { state: "downloading", stage: "Downloading" });
      break;
    case "progress":
      update(job.id, {
        state: "downloading",
        percent: typeof event.percent === "number" ? event.percent : job.percent,
        downloadedBytes: event.downloadedBytes ?? null,
        totalBytes: event.totalBytes ?? null,
        speed: event.speed ?? null,
        eta: event.eta ?? null,
        stage: "Downloading",
      });
      break;
    case "stage":
      update(job.id, { state: "processing", stage: STAGES[event.stage] ?? "Processing" });
      break;
    case "complete":
      update(job.id, { state: "completed", percent: 100, stage: "Done", filepath: event.filepath ?? null });
      void notify(job.id, true);
      break;
    case "cancelled":
      update(job.id, { state: "cancelled", stage: "Cancelled" });
      break;
    case "error":
      update(job.id, {
        state: "failed",
        stage: "Failed",
        error: { code: String(event.code ?? "FAILED"), message: String(event.message ?? "The download failed."), detail: event.detail },
      });
      void notify(job.id, false);
      break;
  }
}

function update(id: string, patch: Partial<Job>): void {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
  const message = { type: "job", job };
  ext.runtime.sendMessage(message).catch(() => undefined);   // popup, if open
  const tabId = tabOfJob.get(id);
  if (tabId !== undefined) ext.tabs.sendMessage(tabId, message).catch(() => undefined);
  if (job.state === "completed" || job.state === "failed" || job.state === "cancelled") {
    tabOfJob.delete(id);
    pruneOldJobs();
  }
}

async function notify(id: string, success: boolean): Promise<void> {
  const settings = await getSettings();
  if (!settings.notifications) return;
  const job = jobs.get(id);
  if (!job) return;
  await ext.notifications.create(`ytdlp-${id}`, {
    type: "basic",
    iconUrl: ext.runtime.getURL("icons/icon-96.png"),
    title: success ? "Download completed" : "Download failed",
    message: success ? (job.filepath?.split(/[\\/]/).pop() ?? job.title) : job.error?.message ?? "yt-dlp reported an error.",
  }).catch(() => undefined);
}

// ------------------------------------------------------------ metadata cache

const cache = new Map<string, { at: number; info: VideoInfo }>();
const inFlightInfo = new Map<string, Promise<VideoInfo>>();

async function info(rawUrl: string): Promise<VideoInfo> {
  const target = videoUrl(rawUrl);
  if (!target) throw { code: "BAD_URL", message: "This is not a YouTube video page." };
  const hit = cache.get(target.id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.info;

  const existing = inFlightInfo.get(target.id);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const data = await request<VideoInfo>("get_info", { url: target.url });
      cache.set(target.id, { at: Date.now(), info: data });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
      return data;
    } finally {
      inFlightInfo.delete(target.id);
    }
  })();

  inFlightInfo.set(target.id, promise);
  return promise;
}

// --------------------------------------------------------------- downloads

const JOBS_MAX_HISTORY = 20;

function pruneOldJobs(): void {
  if (jobs.size <= JOBS_MAX_HISTORY) return;
  for (const [id, job] of jobs) {
    if (job.state === "completed" || job.state === "failed" || job.state === "cancelled") {
      jobs.delete(id);
      if (jobs.size <= JOBS_MAX_HISTORY) break;
    }
  }
}

async function startDownload(message: any, tabId?: number): Promise<Job> {
  const target = videoUrl(String(message.url ?? ""));
  if (!target) throw { code: "BAD_URL", message: "Could not tell which video this is." };
  const settings = await getSettings();
  const mode = message.mode === "audio" ? "audio" : "video";
  const id = newId("job");

  const job: Job = { id, url: target.url, state: "queued", title: String(message.title ?? ""), label: String(message.label ?? ""), percent: 0 };
  jobs.set(id, job);
  if (tabId !== undefined) tabOfJob.set(id, tabId);

  try {
    await request("download", {
      jobId: id,
      url: target.url,
      mode,
      format: String(message.format ?? ""),
      audioFormat: message.audioFormat ?? "best",
      audioQuality: settings.mp3Quality,
      mergeOutputFormat: mode === "video" ? settings.container : null,
      outputDirectory: (message.outputDirectory || settings.downloadDirectory) || null,
      outputTemplate: settings.outputTemplate,
      overwrite: settings.overwrite,
      maxConcurrent: settings.maxConcurrent,
      embedThumbnail: settings.embedThumbnail,
      embedChapters: settings.embedChapters,
      embedMetadata: settings.embedMetadata,
      writeSubtitles: settings.writeSubtitles,
      writeAutoSubtitles: settings.writeAutoSubtitles,
      embedSubtitles: settings.embedSubtitles,
      subLangs: settings.subLangs,
      subFormat: settings.subFormat,
      sponsorblockRemove: settings.sponsorblockRemove,
      sponsorblockMark: settings.sponsorblockMark,
      rateLimit: settings.rateLimit,
      concurrentFragments: settings.concurrentFragments,
      proxy: settings.proxy,
      retries: settings.retries,
      cookiesBrowser: settings.cookiesBrowser,
      keepVideo: settings.keepVideo,
      customArgs: settings.customArgs,
    }, id);
    update(id, { state: "queued" });
  } catch (error: any) {
    update(id, { state: "failed", error });
    throw error;
  }
  return job;
}

// -------------------------------------------------------------- message hub

const PAGE_ALLOWED = new Set(["info", "deps", "download", "cancel", "jobForUrl", "openFolder", "openFile"]);

function openFolderSafe(message: any, fromPage: boolean): Promise<any> {
  const jobId = message.jobId ? String(message.jobId) : "";
  const path = message.path ? String(message.path) : "";
  if (fromPage && !jobId) {
    return Promise.reject({ code: "FORBIDDEN", message: "Job ID required to open folder from webpage." });
  }
  return request("open_folder", { jobId: jobId || undefined, path: path || undefined });
}

function openFileSafe(message: any, fromPage: boolean): Promise<any> {
  const jobId = message.jobId ? String(message.jobId) : "";
  const path = message.path ? String(message.path) : "";
  if (fromPage && !jobId) {
    return Promise.reject({ code: "FORBIDDEN", message: "Job ID required to open file from webpage." });
  }
  return request("open_file", { jobId: jobId || undefined, path: path || undefined });
}

function findJobForUrl(rawUrl: string): Job | null {
  const target = videoUrl(rawUrl);
  if (!target) return null;
  const list = [...jobs.values()].reverse();
  return list.find((j) => {
    const jTarget = j.url ? videoUrl(j.url) : null;
    return jTarget && jTarget.id === target.id;
  }) ?? null;
}

ext.runtime.onMessage.addListener((message: any, sender: any) => {
  if (!message?.type) return undefined;
  const fromPage = Boolean(sender?.tab);
  if (fromPage && !PAGE_ALLOWED.has(message.type)) {
    return Promise.resolve({ ok: false, error: { code: "FORBIDDEN", message: "Not allowed from a page." } });
  }
  const done = (promise: Promise<any>) =>
    promise.then((data) => ({ ok: true, data })).catch((error) => ({ ok: false, error }));

  switch (message.type) {
    case "info":       return done(info(String(message.url ?? "")));
    case "deps":       return done(request<Deps>("get_status", { refresh: Boolean(message.refresh) }));
    case "download":   return done(startDownload(message, sender?.tab?.id));
    case "cancel":     return done(request("cancel", { jobId: String(message.jobId ?? "") }));
    case "jobs":       return Promise.resolve({ ok: true, data: [...jobs.values()].reverse() });
    case "jobForUrl":  return Promise.resolve({ ok: true, data: findJobForUrl(String(message.url ?? "")) });
    case "forget":     jobs.delete(String(message.jobId ?? "")); return Promise.resolve({ ok: true, data: null });
    case "openFolder": return done(openFolderSafe(message, fromPage));
    case "openFile":   return done(openFileSafe(message, fromPage));
    case "setPaths": return done(request("set_config", {
      ytdlpPath: String(message.ytdlpPath ?? ""),
      ffmpegPath: String(message.ffmpegPath ?? ""),
      downloadDirectory: String(message.downloadDirectory ?? ""),
    }));
    case "settings": ext.runtime.openOptionsPage(); return Promise.resolve({ ok: true, data: null });
    default: return undefined;
  }
});

ext.runtime.onInstalled.addListener((details: any) => {
  if (details.reason === "install") ext.runtime.openOptionsPage();
});
