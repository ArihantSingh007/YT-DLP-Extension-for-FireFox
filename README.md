# yt-dlp bridge for Firefox

A small Download button on YouTube that saves the video — or just the audio —
using the **yt-dlp already installed on your computer**. Firefox cannot run local
programs itself, so a tiny Python helper does it. That is the whole design.

The extension never installs software, never downloads executables, never phones
home, and does nothing at all while you are just watching YouTube.

---

# For users

## What you need

| | Why | Where |
|---|---|---|
| Firefox | — | — |
| Python 3.9+ | the helper is a Python program | python.org |
| yt-dlp | does the actual downloading | github.com/yt-dlp/yt-dlp |
| FFmpeg | 1080p and above, and MP3 | ffmpeg.org |
| The helper registration | Firefox requires it before it will talk to a local program | `native-host\install.bat` in this project |

You install Python, yt-dlp and FFmpeg yourself, once. **[docs/SETUP.md](docs/SETUP.md)
walks through it step by step** — it is short.

## Setup in four lines

1. Install Python (tick "Add to PATH"), yt-dlp and FFmpeg.
2. Install the extension.
3. Double-click `native-host\install.bat`.
4. Restart Firefox, then check Settings → Dependencies shows all green.

## Downloading

Open a video → **Download** → **Video** or **Music** → pick a quality →
**Download**. Progress, cancel and the queue live in the toolbar popup.

* Video: Best available, 2160p, 1440p, 1080p, 720p, 480p, 360p — only the ones
  this video actually has.
* Music: Best available, M4A, MP3, Opus. M4A and Opus are copied as-is; MP3 is
  converted with FFmpeg, which cannot add quality the source does not have.

Something wrong? [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Privacy

The current video URL goes to the local helper and nowhere else. No analytics,
no telemetry, no remote server, no cookies read, no account needed.

---

# For developers

## Structure

```
extension/
  src/shared.ts      API handle, types, settings, URL parsing, formatting
  src/formats.ts     yt-dlp formats -> the user-facing list (pure, unit-tested)
  src/background.ts  native port, metadata cache, job mirror, message hub
  src/content.ts     button placement + dialog
  src/options.*  src/popup.*  src/ui.css
  src/test/formats.test.ts
  public/manifest.json + icons/      build.mjs (esbuild)
native-host/
  src/host.py      protocol, dispatch, config, seven actions
  src/ytdlp.py     tool discovery, argv, output parsing, error mapping
  src/jobs.py      one process per job, queue, cancel, cleanup
  src/validate.py  every untrusted field
  install.bat  install-windows.ps1  install-linux.sh  install-macos.sh
  run-host.bat  run-host.sh   tests/
docs/ SETUP.md DEVELOPMENT.md TROUBLESHOOTING.md SECURITY.md
```

## Commands & Reproducible Build

**Prerequisites:** Node.js 20 LTS (or newer), npm 10 (or newer), Python 3.9+.

```bash
cd extension
npm ci             # install exact pinned dependencies
npm run build      # dist/ (unminified ES bundles for AMO reviewers)
npm run dev        # watch & rebuild on changes
npm run typecheck  # tsc --noEmit
npm test           # 18 unit tests
npm run package    # builds dist/ and packages both artifacts into web-ext-artifacts/:
                   #  1. ytdlp-bridge-2.0.0.zip (Extension package for AMO)
                   #  2. ytdlp-bridge-2.0.0-source.zip (Source code for AMO reviewers)

cd ../native-host
python -m unittest discover -s tests -v   # 51 unit tests
```

Load `extension/dist/manifest.json` via `about:debugging` while developing.
That is a developer path; users install the signed build from AMO.

More in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), including AMO submission
notes. Security model: [docs/SECURITY.md](docs/SECURITY.md).

## Architecture

```
YouTube page ──► content script ──► background ──► helper ──► yt-dlp ──► FFmpeg
   (button)        (dialog only)     (native port)  (Python)   (on demand)
```

Idle cost: no timers anywhere, no permanent DOM observer, no yt-dlp process, no
network traffic from the extension.

## Permissions

| Permission | Why |
|---|---|
| `nativeMessaging` | the only way to reach yt-dlp |
| `storage` | your settings; no credentials stored |
| `notifications` | the completion toast; off in settings means never used |
| `*://www.youtube.com/*`, `*://music.youtube.com/*` | where the button lives, and needed to message the content script |

Not requested: `<all_urls>`, `tabs`, `scripting`, `downloads`, `m.youtube.com`.
