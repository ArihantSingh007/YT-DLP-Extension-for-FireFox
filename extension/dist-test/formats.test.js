// src/test/formats.test.ts
import { strict as assert } from "node:assert";
import test from "node:test";

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

// src/test/formats.test.ts
var S = { ...DEFAULTS };
var RAW = [
  { format_id: "sb0", ext: "mhtml", vcodec: "none", acodec: "none", protocol: "mhtml" },
  { format_id: "hls", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 720, protocol: "m3u8_native" },
  { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 129, filesize: 3e6 },
  { format_id: "251", ext: "webm", vcodec: "none", acodec: "opus", abr: 160, filesize: 36e5 },
  { format_id: "18", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 360, fps: 30, filesize: 12e6 },
  { format_id: "136", ext: "mp4", vcodec: "avc1", acodec: "none", height: 720, fps: 30, filesize: 4e7 },
  { format_id: "299", ext: "mp4", vcodec: "avc1", acodec: "none", height: 1080, fps: 60, filesize: 12e7 },
  { format_id: "315", ext: "webm", vcodec: "vp9", acodec: "none", height: 2160, fps: 60, filesize: 9e8 },
  { format_id: "new", ext: "mp4", vcodec: "codec9", acodec: "none", height: 1080, unknown_field: 1 }
];
test("storyboards and HLS never reach the user", () => {
  const labels = videoChoices(RAW, 600, S).map((c) => c.label);
  assert.deepEqual(labels, ["Best available", "2160p", "1080p", "720p", "360p"]);
});
test("video-only streams get merged with the best audio, with a fallback", () => {
  const p1080 = videoChoices(RAW, 600, S).find((c) => c.key === "p1080");
  assert.equal(p1080.selector, "299+140/bestvideo[height<=1080]+bestaudio/best[height<=1080]");
  assert.equal(p1080.needsFfmpeg, true);
  assert.match(p1080.note, /~117 MB|~1[12]\d MB/);
});
test("a stream that already has audio needs no ffmpeg", () => {
  const p360 = videoChoices(RAW, 600, S).find((c) => c.key === "p360");
  assert.equal(p360.needsFfmpeg, false);
  assert.equal(p360.selector, "18/bestvideo[height<=360]+bestaudio/best[height<=360]");
});
test("the quality setting caps what is offered", () => {
  const choices = videoChoices(RAW, 600, { ...S, videoQuality: "720" });
  assert.deepEqual(choices.map((c) => c.label), ["Best available", "720p", "360p"]);
  assert.ok(choices[0].selector.includes("[height<=720]"));
});
test("MP4 is preferred over WebM at the same resolution", () => {
  const raw = [
    { format_id: "a", ext: "webm", vcodec: "vp9", acodec: "none", height: 1080, tbr: 5e3 },
    { format_id: "b", ext: "mp4", vcodec: "avc1", acodec: "none", height: 1080, tbr: 3e3 },
    { format_id: "c", ext: "m4a", vcodec: "none", acodec: "mp4a", abr: 128 }
  ];
  assert.match(videoChoices(raw, 100, S).find((c) => c.key === "p1080").selector, /^b\+c\//);
});
test("audio list is exactly Best, M4A, MP3, Opus and only MP3 converts", () => {
  const choices = audioChoices(RAW, 600, S);
  assert.deepEqual(choices.map((c) => c.label), ["Best available", "M4A", "MP3", "Opus"]);
  assert.deepEqual(choices.map((c) => c.needsFfmpeg), [false, false, true, false]);
  assert.match(choices[2].note, /converted from the 160 kbps source/);
});
test("no formats means no choices, not a crash", () => {
  assert.deepEqual(videoChoices([], null, S), []);
  assert.deepEqual(audioChoices(void 0, null, S), []);
});
test("labels stay user-friendly and every selector has a fallback", () => {
  for (const choice of [...videoChoices(RAW, 600, S), ...audioChoices(RAW, 600, S)]) {
    assert.doesNotMatch(choice.label, /\+|avc1|vp9|opus\d|\b\d{3}\b/);
    assert.ok(choice.selector.includes("/"), `${choice.key} has no fallback`);
  }
});
test("a resolution the video does not have is never offered", () => {
  const raw = [
    { format_id: "v", ext: "mp4", vcodec: "avc1", acodec: "none", height: 720, tbr: 1e3 },
    { format_id: "a", ext: "m4a", vcodec: "none", acodec: "mp4a", abr: 128 }
  ];
  assert.deepEqual(videoChoices(raw, 60, S).map((c) => c.label), ["Best available", "720p"]);
});
test("URL parsing keeps the video and drops the playlist", () => {
  assert.equal(videoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1").url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(videoUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ").shorts, true);
  assert.equal(videoUrl("https://youtu.be/dQw4w9WgXcQ").id, "dQw4w9WgXcQ");
  assert.equal(videoUrl("https://www.youtube.com/live/dQw4w9WgXcQ").id, "dQw4w9WgXcQ");
  assert.equal(videoUrl("https://www.youtube.com/feed/subscriptions"), null);
  assert.equal(videoUrl("https://evil.example.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(videoUrl("javascript:alert(1)"), null);
});
test("byte and clock formatting", () => {
  assert.equal(bytes(0), "");
  assert.equal(bytes(65e7, true), "~620 MB");
  assert.equal(clock(763), "12:43");
  assert.equal(clock(3671), "1:01:11");
});
