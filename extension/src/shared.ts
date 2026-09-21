/** Everything shared by the four entry points: API handle, types, settings,
 * URL parsing and number formatting. One small file instead of five. */

export const ext: any = (globalThis as any).browser ?? (globalThis as any).chrome;

// ------------------------------------------------------------------- types

export type Mode = "video" | "audio";

export interface RawFormat {
  format_id: string;
  ext?: string;
  height?: number | null;
  width?: number | null;
  fps?: number | null;
  vcodec?: string | null;
  acodec?: string | null;
  abr?: number | null;
  tbr?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  protocol?: string | null;
  [key: string]: unknown; // unknown yt-dlp fields are ignored, never fatal
}

export interface VideoInfo {
  id: string;
  title: string;
  uploader?: string;
  duration?: number;
  thumbnail?: string;
  isLive?: boolean;
  webpageUrl: string;
  formats: RawFormat[];
}

export interface Choice {
  key: string;
  label: string;
  note: string;          // short, human: "~620 MB" or "converted with ffmpeg"
  selector: string;      // yt-dlp -f value
  audioFormat?: string;
  needsFfmpeg: boolean;
}

export interface Job {
  id: string;
  url?: string;
  state: "queued" | "downloading" | "processing" | "completed" | "failed" | "cancelled";
  title: string;
  label: string;
  percent: number;
  stage?: string;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
  speed?: number | null;
  eta?: number | null;
  filepath?: string | null;
  error?: { code: string; message: string; detail?: string } | null;
}

export interface Deps {
  ytdlp: { found: boolean; path: string | null; version: string | null };
  ffmpeg: { found: boolean; path: string | null; version: string | null };
  downloadDirectory: string;
  hostVersion?: string;
  python?: string;
  logFile?: string;
}

export type Reply<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; detail?: string } };

export async function send<T>(message: Record<string, unknown>): Promise<Reply<T>> {
  try {
    return (await ext.runtime.sendMessage(message)) as Reply<T>;
  } catch (cause: any) {
    return { ok: false, error: { code: "EXTENSION_ERROR", message: "The extension is not responding.", detail: String(cause?.message ?? cause) } };
  }
}

// ---------------------------------------------------------------- settings

export interface Settings {
  downloadDirectory: string;
  askWhereToSave: boolean;
  videoQuality: "best" | "2160" | "1440" | "1080" | "720" | "480";
  container: "mp4" | "mkv" | "webm";
  audioFormat: "best" | "m4a" | "mp3" | "opus";
  notifications: boolean;
  // advanced (collapsed in the settings page)
  mp3Quality: "best" | "320" | "256" | "192" | "128";
  outputTemplate: string;
  overwrite: "never" | "overwrite";
  maxConcurrent: number;
  lastMode: Mode;
  // Metadata & Media
  embedThumbnail: boolean;
  embedChapters: boolean;
  embedMetadata: boolean;
  // Subtitles
  writeSubtitles: boolean;
  writeAutoSubtitles: boolean;
  embedSubtitles: boolean;
  subLangs: string;
  subFormat: "best" | "srt" | "vtt" | "ass" | "lrc";
  // SponsorBlock
  sponsorblockRemove: "off" | "sponsor" | "sponsor,selfpromo" | "sponsor,selfpromo,interaction" | "all";
  sponsorblockMark: "off" | "sponsor" | "all";
  // Network & Speed
  rateLimit: string;
  concurrentFragments: number;
  proxy: string;
  retries: number;
  // Authentication & Cookies
  cookiesBrowser: "none" | "firefox" | "chrome" | "edge" | "brave" | "chromium" | "vivaldi" | "opera";
  // Audio
  keepVideo: boolean;
  // System
  customArgs: string;
}

export const DEFAULTS: Settings = {
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
  customArgs: "",
};

export async function getSettings(): Promise<Settings> {
  const stored = await ext.storage.local.get("settings");
  return { ...DEFAULTS, ...(stored?.settings ?? {}) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await ext.storage.local.set({ settings: next });
  return next;
}

// --------------------------------------------------------------------- url

const HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Returns the canonical single-video URL, or null if this is not a video page.
 * The `list=` parameter is dropped so a playlist never downloads by accident. */
export function videoUrl(raw: string): { id: string; url: string; shorts: boolean } | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  let id: string | null = null;
  let shorts = false;
  if (parsed.hostname === "youtu.be") id = parts[0] ?? null;
  else if (parts[0] === "shorts" || parts[0] === "live" || parts[0] === "embed") {
    id = parts[1] ?? null;
    shorts = parts[0] === "shorts";
  } else if (parsed.pathname === "/watch") id = parsed.searchParams.get("v");
  if (!id || !VIDEO_ID.test(id)) return null;
  return { id, url: `https://www.youtube.com/watch?v=${id}`, shorts };
}

// ------------------------------------------------------------- formatting

export function bytes(value: number | null | undefined, approx = false): string {
  if (!value || !isFinite(value) || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u += 1; }
  return `${approx ? "~" : ""}${n.toFixed(n >= 100 || u === 0 ? 0 : 1)} ${units[u]}`;
}

export function clock(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return "";
  const t = Math.round(seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
