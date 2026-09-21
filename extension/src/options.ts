import { DEFAULTS, getSettings, send, setSettings, type Deps, type Settings } from "./shared";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement & HTMLSelectElement;

const CHECKS: (keyof Settings)[] = [
  "askWhereToSave",
  "notifications",
  "embedThumbnail",
  "embedChapters",
  "embedMetadata",
  "writeSubtitles",
  "writeAutoSubtitles",
  "embedSubtitles",
  "keepVideo",
];

const VALUES: (keyof Settings)[] = [
  "downloadDirectory",
  "videoQuality",
  "container",
  "audioFormat",
  "mp3Quality",
  "overwrite",
  "maxConcurrent",
  "outputTemplate",
  "subLangs",
  "subFormat",
  "sponsorblockRemove",
  "sponsorblockMark",
  "rateLimit",
  "concurrentFragments",
  "proxy",
  "retries",
  "cookiesBrowser",
  "customArgs",
];

async function hydrate(): Promise<void> {
  const settings = await getSettings();
  for (const key of CHECKS) {
    const el = $(key);
    if (!el) continue;
    el.checked = Boolean(settings[key]);
    el.addEventListener("change", () => void setSettings({ [key]: el.checked } as Partial<Settings>));
  }
  for (const key of VALUES) {
    const el = $(key);
    if (!el) continue;
    el.value = String(settings[key] ?? DEFAULTS[key]);
    el.addEventListener("change", () => {
      let value: any = el.value;
      if (key === "maxConcurrent") value = Math.max(1, Math.min(8, Number(el.value) || 1));
      if (key === "concurrentFragments") value = Math.max(1, Math.min(16, Number(el.value) || 1));
      if (key === "retries") value = Math.max(1, Math.min(30, Number(el.value) || 5));
      void setSettings({ [key]: value } as Partial<Settings>);
    });
  }
}

function mark(id: string, ok: boolean, text: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `pill-badge ${ok ? "ok" : "bad"}`;
  el.textContent = text;
}

function renderNote(container: HTMLElement, type: "success" | "warning", strongText: string, messageText: string, codeHint?: string): void {
  container.replaceChildren();
  const box = document.createElement("div");
  box.className = `note ${type}`;
  const inner = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = strongText + " ";
  inner.append(strong);
  inner.append(document.createTextNode(messageText));
  if (codeHint) {
    inner.append(document.createElement("br"));
    const label = document.createTextNode("Setup guide: ");
    const code = document.createElement("code");
    code.textContent = codeHint;
    inner.append(label, code);
  }
  box.append(inner);
  container.append(box);
}

async function check(refresh = false): Promise<void> {
  const reply = await send<Deps>({ type: "deps", refresh });
  const help = document.getElementById("help")!;
  const pathsEl = document.getElementById("paths");

  if (!reply.ok) {
    mark("s-host", false, "Not installed");
    mark("s-python", false, "—");
    mark("s-ytdlp", false, "—");
    mark("s-ffmpeg", false, "—");
    if (pathsEl) pathsEl.textContent = "Helper disconnected";
    renderNote(
      help,
      "warning",
      "One-time setup required.",
      "The native helper is not registered with Firefox, or Python is not available. Run native-host\\install.bat and restart Firefox.",
      "docs/SETUP.md"
    );
    return;
  }

  const deps = reply.data;
  mark("s-host", true, `Ready (${deps.hostVersion ?? "2.0.0"})`);
  mark("s-python", true, deps.python ? `Python ${deps.python}` : "Available");
  mark("s-ytdlp", deps.ytdlp.found, deps.ytdlp.found ? `Detected ${deps.ytdlp.version ?? ""}`.trim() : "Not found");
  mark("s-ffmpeg", deps.ffmpeg.found, deps.ffmpeg.found ? "Detected" : "Not found");

  if (pathsEl) {
    pathsEl.textContent = deps.downloadDirectory || "System default Downloads folder";
  }

  if (deps.ytdlp.found && deps.ffmpeg.found) {
    renderNote(help, "success", "Ready to download.", "All tools are detected and operating properly.");
  } else {
    renderNote(
      help,
      "warning",
      "Missing dependencies.",
      "Install the missing tool, or specify its exact binary path under Advanced Options below.",
      "docs/SETUP.md"
    );
  }
}

document.getElementById("test")?.addEventListener("click", () => void check(true));

document.getElementById("savePaths")?.addEventListener("click", async () => {
  const note = document.getElementById("advNote");
  const patch: Partial<Settings> = {};
  for (const key of CHECKS) {
    const el = $(key);
    if (el) (patch as any)[key] = el.checked;
  }
  for (const key of VALUES) {
    const el = $(key);
    if (el) {
      if (key === "maxConcurrent" || key === "concurrentFragments" || key === "retries") {
        (patch as any)[key] = Number(el.value) || (DEFAULTS[key] as number);
      } else {
        (patch as any)[key] = el.value.trim();
      }
    }
  }
  await setSettings(patch);

  const reply = await send<any>({
    type: "setPaths",
    ytdlpPath: $("ytdlpPath")?.value.trim() ?? "",
    ffmpegPath: $("ffmpegPath")?.value.trim() ?? "",
    downloadDirectory: $("downloadDirectory")?.value.trim() ?? "",
  });
  if (note) {
    note.textContent = reply.ok ? "All settings saved successfully." : (reply.error?.message ?? "Saved in browser.");
    note.style.color = reply.ok ? "var(--success)" : "var(--danger)";
    setTimeout(() => { note.textContent = ""; }, 4000);
  }
  if (reply.ok) void check(true);
});

void hydrate().then(() => check());
