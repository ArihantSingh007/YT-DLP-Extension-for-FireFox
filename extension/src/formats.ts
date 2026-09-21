/** yt-dlp formats -> the short list a person actually wants to see.
 * Pure functions: no DOM, no browser APIs, fully unit-tested. */
import type { Choice, RawFormat, Settings } from "./shared";
import { bytes } from "./shared";

const STEPS = [2160, 1440, 1080, 720, 480, 360];

interface F {
  id: string; ext: string; height: number; fps: number;
  video: boolean; audio: boolean; abr: number; tbr: number; size: number | null;
}

function clean(raw: RawFormat[] | undefined, duration?: number | null): F[] {
  if (!Array.isArray(raw)) return [];
  const out: F[] = [];
  for (const f of raw) {
    if (!f || typeof f.format_id !== "string") continue;
    const ext = String(f.ext ?? "").toLowerCase();
    const protocol = String(f.protocol ?? "").toLowerCase();
    if (ext === "mhtml" || protocol.startsWith("m3u8") || protocol === "ism" || protocol === "f4m") continue;
    const video = !!f.vcodec && f.vcodec !== "none";
    const audio = !!f.acodec && f.acodec !== "none";
    if (!video && !audio) continue;
    const tbr = typeof f.tbr === "number" ? f.tbr : 0;
    const size = f.filesize ?? f.filesize_approx ??
      (tbr && duration ? Math.round((tbr * 1000 * duration) / 8) : null);
    out.push({
      id: f.format_id, ext, height: Number(f.height) || 0, fps: Number(f.fps) || 0,
      video, audio, abr: Number(f.abr) || 0, tbr, size: size ?? null,
    });
  }
  return out;
}

/** Highest-quality audio stream, preferring one that matches the container. */
function bestAudio(formats: F[], container: string): F | undefined {
  const wanted = container === "webm" ? /^webm$/ : container === "mp4" ? /^(m4a|mp4)$/ : /./;
  const audio = formats.filter((f) => f.audio && !f.video);
  return audio.sort((a, b) =>
    (wanted.test(b.ext) ? 1e6 : 0) + (b.abr || b.tbr) - ((wanted.test(a.ext) ? 1e6 : 0) + (a.abr || a.tbr)))[0];
}

/** Best stream inside one resolution bucket: prefer a container match, then a
 * single stream that already has audio, then bitrate. */
function bestVideo(bucket: F[], container: string): F {
  const wanted = container === "webm" ? /^webm$/ : /^mp4$/;
  return bucket.slice().sort((a, b) => score(b) - score(a))[0];
  function score(f: F): number {
    return (wanted.test(f.ext) ? 4000 : 0) + (f.audio ? 300 : 0) + (f.fps >= 50 ? 200 : 0) + f.tbr;
  }
}

export function videoChoices(raw: RawFormat[] | undefined, duration: number | null, settings: Settings): Choice[] {
  const formats = clean(raw, duration);
  const cap = settings.videoQuality === "best" ? Infinity : Number(settings.videoQuality);
  const videos = formats.filter((f) => f.video && f.height && f.height <= cap);
  if (!videos.length) return [];
  const audio = bestAudio(formats, settings.container);
  const limit = cap === Infinity ? "" : `[height<=${cap}]`;

  const top = bestVideo(videos.filter((f) => f.height === Math.max(...videos.map((v) => v.height))), settings.container);
  const choices: Choice[] = [{
    key: "best",
    label: "Best available",
    note: note(top, audio, `${top.height}p`),
    selector: `bestvideo*${limit}+bestaudio/best${limit}`,
    needsFfmpeg: !top.audio,
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
      note: note(pick, merge ? audio : undefined, ""),
      selector: merge ? `${pick.id}+${audio!.id}/${fallback}` : `${pick.id}/${fallback}`,
      needsFfmpeg: merge,
    });
  }
  return choices;

  function note(video: F, mergedAudio: F | undefined, prefix: string): string {
    const size = video.size == null ? "" : bytes(video.size + (mergedAudio?.size ?? 0), true);
    return [prefix, video.fps >= 50 ? "60 fps" : "", size].filter(Boolean).join(" • ");
  }
}

export function audioChoices(raw: RawFormat[] | undefined, duration: number | null, settings: Settings): Choice[] {
  const formats = clean(raw, duration).filter((f) => f.audio && !f.video);
  if (!formats.length) return [];
  const best = formats.slice().sort((a, b) => (b.abr || b.tbr) - (a.abr || a.tbr))[0];
  const m4a = formats.filter((f) => /^(m4a|mp4)$/.test(f.ext)).sort((a, b) => b.abr - a.abr)[0];
  const opus = formats.filter((f) => f.ext === "webm").sort((a, b) => b.abr - a.abr)[0];

  const choices: Choice[] = [{
    key: "best", label: "Best available", note: bytes(best.size, true),
    selector: "bestaudio/best", audioFormat: "best", needsFfmpeg: false,
  }];
  if (m4a) choices.push({
    key: "m4a", label: "M4A", note: bytes(m4a.size, true),
    selector: "bestaudio[ext=m4a]/bestaudio", audioFormat: "m4a", needsFfmpeg: false,
  });
  choices.push({
    key: "mp3", label: "MP3",
    note: `converted from the ${Math.round(best.abr || best.tbr) || "?"} kbps source`,
    selector: "bestaudio/best", audioFormat: "mp3", needsFfmpeg: true,
  });
  if (opus) choices.push({
    key: "opus", label: "Opus", note: bytes(opus.size, true),
    selector: "bestaudio[acodec^=opus]/bestaudio[ext=webm]/bestaudio", audioFormat: "opus", needsFfmpeg: false,
  });
  return choices;
}
