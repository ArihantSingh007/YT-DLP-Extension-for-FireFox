import { DEFAULTS, getSettings, send, setSettings, type Deps, type Settings } from "./shared";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement & HTMLSelectElement;

const CHECKS: (keyof Settings)[] = ["askWhereToSave", "notifications"];
const VALUES: (keyof Settings)[] = ["downloadDirectory", "videoQuality", "container", "audioFormat",
  "mp3Quality", "overwrite", "maxConcurrent", "outputTemplate"];

async function hydrate(): Promise<void> {
  const settings = await getSettings();
  for (const key of CHECKS) {
    const el = $(key);
    el.checked = Boolean(settings[key]);
    el.addEventListener("change", () => void setSettings({ [key]: el.checked } as Partial<Settings>));
  }
  for (const key of VALUES) {
    const el = $(key);
    el.value = String(settings[key] ?? DEFAULTS[key]);
    el.addEventListener("change", () => {
      const value = key === "maxConcurrent" ? Math.max(1, Math.min(8, Number(el.value) || 1)) : el.value;
      void setSettings({ [key]: value } as Partial<Settings>);
    });
  }
}

function mark(id: string, ok: boolean, text: string): void {
  const el = document.getElementById(id)!;
  el.className = ok ? "ok" : "bad";
  el.textContent = text;
}

const SETUP = `<div class="note"><strong>Setup required.</strong> The local helper is not registered
with Firefox, or Python is not available to it. Install Python 3.9+, then double-click
<code>native-host\\install.bat</code> from the downloaded project folder and restart Firefox.
Full steps are in <code>docs/SETUP.md</code>.</div>`;

async function check(): Promise<void> {
  const reply = await send<Deps>({ type: "deps" });
  const help = document.getElementById("help")!;
  if (!reply.ok) {
    mark("s-host", false, "Not installed");
    mark("s-python", false, "—");
    mark("s-ytdlp", false, "—");
    mark("s-ffmpeg", false, "—");
    help.innerHTML = SETUP;
    return;
  }
  const deps = reply.data;
  mark("s-host", true, `Ready (${deps.hostVersion ?? "?"})`);
  mark("s-python", true, deps.python ? `Python ${deps.python}` : "Available");
  mark("s-ytdlp", deps.ytdlp.found, deps.ytdlp.found ? `Detected ${deps.ytdlp.version}` : "Not found");
  mark("s-ffmpeg", deps.ffmpeg.found, deps.ffmpeg.found ? "Detected" : "Not found");
  document.getElementById("paths")!.textContent = deps.downloadDirectory;
  help.innerHTML = deps.ytdlp.found && deps.ffmpeg.found
    ? `<div class="note">Everything is ready.</div>`
    : `<div class="note">Install the missing tool, or enter its full path under Advanced.
       <br>Setup steps: <code>docs/SETUP.md</code></div>`;
}

document.getElementById("test")!.addEventListener("click", () => void check());
document.getElementById("savePaths")!.addEventListener("click", async () => {
  const reply = await send({
    type: "setPaths",
    ytdlpPath: $("ytdlpPath").value.trim(),
    ffmpegPath: $("ffmpegPath").value.trim(),
    downloadDirectory: $("downloadDirectory").value.trim(),
  });
  document.getElementById("advNote")!.textContent = reply.ok ? "Saved." : reply.error.message;
  if (reply.ok) void check();
});

void hydrate().then(check);
