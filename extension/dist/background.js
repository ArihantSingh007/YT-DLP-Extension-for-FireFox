"use strict";
(() => {
  // src/shared.ts
  var ext = globalThis.browser ?? globalThis.chrome;
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

  // src/background.ts
  var HOST = "com.kcgamingtech.ytdlp_bridge";
  var CACHE_TTL_MS = 5 * 60 * 1e3;
  var CACHE_MAX = 8;
  var port = null;
  var pending = /* @__PURE__ */ new Map();
  var jobs = /* @__PURE__ */ new Map();
  var tabOfJob = /* @__PURE__ */ new Map();
  var counter = 0;
  var newId = (prefix) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;
  function connect() {
    if (port) return port;
    port = ext.runtime.connectNative(HOST);
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
  function helperMessage() {
    return "The local helper is not installed or stopped responding.";
  }
  function request(action, payload = {}, id = newId("r")) {
    return new Promise((resolve, reject) => {
      let live;
      try {
        live = connect();
      } catch (cause) {
        reject({ code: "NO_HELPER", message: helperMessage(), detail: String(cause?.message ?? cause) });
        return;
      }
      pending.set(id, { resolve, reject });
      try {
        live.postMessage({ id, action, ...payload });
      } catch (cause) {
        pending.delete(id);
        reject({ code: "NO_HELPER", message: helperMessage(), detail: String(cause?.message ?? cause) });
      }
    });
  }
  function onNativeMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.event) return onJobEvent(message);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.success) waiter.resolve(message.data ?? {});
    else waiter.reject(message.error ?? { code: "UNKNOWN", message: "The helper reported an error." });
  }
  var STAGES = {
    Merger: "Merging video and audio",
    ExtractAudio: "Converting audio",
    Metadata: "Writing metadata"
  };
  function onJobEvent(event) {
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
          stage: "Downloading"
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
          error: { code: String(event.code ?? "FAILED"), message: String(event.message ?? "The download failed."), detail: event.detail }
        });
        void notify(job.id, false);
        break;
    }
  }
  function update(id, patch) {
    const job = jobs.get(id);
    if (!job) return;
    Object.assign(job, patch);
    const message = { type: "job", job };
    ext.runtime.sendMessage(message).catch(() => void 0);
    const tabId = tabOfJob.get(id);
    if (tabId !== void 0) ext.tabs.sendMessage(tabId, message).catch(() => void 0);
    if (job.state === "completed" || job.state === "failed" || job.state === "cancelled") tabOfJob.delete(id);
  }
  async function notify(id, success) {
    const settings = await getSettings();
    if (!settings.notifications) return;
    const job = jobs.get(id);
    if (!job) return;
    await ext.notifications.create(`ytdlp-${id}`, {
      type: "basic",
      iconUrl: ext.runtime.getURL("icons/icon-96.png"),
      title: success ? "Download completed" : "Download failed",
      message: success ? job.filepath?.split(/[\\/]/).pop() ?? job.title : job.error?.message ?? "yt-dlp reported an error."
    }).catch(() => void 0);
  }
  var cache = /* @__PURE__ */ new Map();
  async function info(rawUrl) {
    const target = videoUrl(rawUrl);
    if (!target) throw { code: "BAD_URL", message: "This is not a YouTube video page." };
    const hit = cache.get(target.id);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.info;
    const data = await request("get_info", { url: target.url });
    cache.set(target.id, { at: Date.now(), info: data });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return data;
  }
  async function startDownload(message, tabId) {
    const target = videoUrl(String(message.url ?? ""));
    if (!target) throw { code: "BAD_URL", message: "Could not tell which video this is." };
    const settings = await getSettings();
    const mode = message.mode === "audio" ? "audio" : "video";
    const id = newId("job");
    const job = { id, state: "queued", title: String(message.title ?? ""), label: String(message.label ?? ""), percent: 0 };
    jobs.set(id, job);
    if (tabId !== void 0) tabOfJob.set(id, tabId);
    try {
      await request("download", {
        jobId: id,
        url: target.url,
        mode,
        format: String(message.format ?? ""),
        audioFormat: message.audioFormat ?? "best",
        audioQuality: settings.mp3Quality,
        mergeOutputFormat: mode === "video" ? settings.container : null,
        outputDirectory: message.outputDirectory || settings.downloadDirectory || null,
        outputTemplate: settings.outputTemplate,
        overwrite: settings.overwrite,
        maxConcurrent: settings.maxConcurrent
      }, id);
      update(id, { state: "queued" });
    } catch (error) {
      update(id, { state: "failed", error });
      throw error;
    }
    return job;
  }
  var PAGE_ALLOWED = /* @__PURE__ */ new Set(["info", "deps", "download", "cancel"]);
  ext.runtime.onMessage.addListener((message, sender) => {
    if (!message?.type) return void 0;
    const fromPage = Boolean(sender?.tab);
    if (fromPage && !PAGE_ALLOWED.has(message.type)) {
      return Promise.resolve({ ok: false, error: { code: "FORBIDDEN", message: "Not allowed from a page." } });
    }
    const done = (promise) => promise.then((data) => ({ ok: true, data })).catch((error) => ({ ok: false, error }));
    switch (message.type) {
      case "info":
        return done(info(String(message.url ?? "")));
      case "deps":
        return done(request("get_status"));
      case "download":
        return done(startDownload(message, sender?.tab?.id));
      case "cancel":
        return done(request("cancel", { jobId: String(message.jobId ?? "") }));
      case "jobs":
        return Promise.resolve({ ok: true, data: [...jobs.values()].reverse() });
      case "forget":
        jobs.delete(String(message.jobId ?? ""));
        return Promise.resolve({ ok: true, data: null });
      case "openFolder":
        return done(request("open_folder", { path: String(message.path ?? "") }));
      case "setPaths":
        return done(request("set_config", {
          ytdlpPath: String(message.ytdlpPath ?? ""),
          ffmpegPath: String(message.ffmpegPath ?? ""),
          downloadDirectory: String(message.downloadDirectory ?? "")
        }));
      case "settings":
        ext.runtime.openOptionsPage();
        return Promise.resolve({ ok: true, data: null });
      default:
        return void 0;
    }
  });
  ext.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") ext.runtime.openOptionsPage();
  });
})();
