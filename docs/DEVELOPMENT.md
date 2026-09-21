# Development

## Where things live

| File | Responsibility |
|---|---|
| `src/shared.ts` | The API handle, types, settings, URL parsing, byte/time formatting. Everything else imports from here. |
| `src/formats.ts` | Pure functions: yt-dlp's format array → the short list the dialog shows, plus the `-f` selector. No DOM, unit-tested. |
| `src/background.ts` | The trust boundary: one lazy native port, the 5-minute metadata cache, the job mirror, the message hub. |
| `src/content.ts` | Button placement and the dialog. Knows nothing about yt-dlp beyond calling `formats.ts`. |
| `native-host/src/host.py` | Framing, dispatch, config, the seven actions. |
| `native-host/src/ytdlp.py` | Finding the tools, building argv, parsing output, mapping errors. |
| `native-host/src/jobs.py` | One process per job, queue, cancel, partial-file cleanup. |
| `native-host/src/validate.py` | Every untrusted field. |

## Commands

```bash
cd extension
npm run build      # dist/
npm run dev        # watch
npm run typecheck  # tsc --noEmit (same as npm run lint)
npm test           # node --test
npm run package    # zip for AMO

cd ../native-host
python -m unittest discover -s tests -v
```

## Protocol

Request → response, matched by `id`:

```json
{"id": "r1", "action": "get_info", "url": "https://www.youtube.com/watch?v=..."}
{"id": "r1", "success": true, "data": {"title": "...", "formats": []}}
{"id": "r1", "success": false, "error": {"code": "NO_YTDLP", "message": "..."}}
```

Downloads reuse the job id and stream events:

```json
{"id": "job3", "event": "progress", "percent": 42.7, "downloadedBytes": 1,
 "totalBytes": 3, "speed": 2500000, "eta": 71}
{"id": "job3", "event": "stage", "stage": "Merger"}
{"id": "job3", "event": "complete", "filepath": "..."}
```

Actions: `ping`, `get_status`, `get_info`, `download`, `cancel`, `open_folder`,
`set_config`. Content scripts may only trigger `info`, `deps`, `download`,
`cancel` through the background page.

## Idle behaviour (the point of 2.0)

* No `setInterval`, no `setTimeout`, no `requestAnimationFrame` anywhere.
* The content script observes the DOM **only** while the action bar is missing,
  scoped to `ytd-watch-flexy`/`ytd-shorts`/`ytd-page-manager`, and disconnects
  the observer the moment the button is placed.
* Navigation is handled by YouTube's own `yt-navigate-finish` event plus
  `popstate` — no URL polling.
* The native port is opened on the first request, so nothing runs until you
  click Download. The helper blocks on `stdin.read()` between messages.
* yt-dlp is only invoked when the dialog opens (and not at all if the metadata
  cache still has this video) or when a download starts.

## Debugging

* Background console: `about:debugging` → Inspect.
* Helper log: `%APPDATA%\ytdlp-bridge\native-host.log`.
* Talk to the helper without Firefox: see `tests/test_host.py`,
  `NativeMessagingTests` — it speaks the real protocol over a subprocess.

## Changing the quality list

`videoChoices()` / `audioChoices()` in `src/formats.ts` are the only place that
decides what the user sees and which selector is used. Every selector ends in a
generic fallback (`.../bestvideo[height<=N]+bestaudio/best[height<=N]`) so a
stream disappearing between metadata and download does not break the job. Add a
test beside the existing ones — they use plain objects, no browser.

## Packaging and AMO submission

Run the packaging script:

```bash
cd extension
npm ci
npm run package
```

This generates two artifacts in `extension/web-ext-artifacts/`:

1. **`ytdlp-bridge-2.0.0.zip`** (The Extension Package):
   - Upload this to the main add-on upload field on AMO.
   - Contains only the compiled `dist/` files: 4 JavaScript bundles (`content.js`, `background.js`, `options.js`, `popup.js`), 2 HTML pages, 1 stylesheet (`ui.css`), `manifest.json`, and icons.
   - Contains zero binaries, zero source maps, zero tests, zero node_modules.
   - Passes `npx addons-linter` with 0 errors, 0 warnings, and 0 notices.

2. **`ytdlp-bridge-2.0.0-source.zip`** (The Source Code for Reviewers):
   - Upload this when AMO asks: *"Does your add-on contain code that is compiled or minified? -> Yes"*.
   - Strictly excludes `node_modules/` (no `@esbuild/win32-x64/esbuild.exe`), `.git/`, `dist/`, and Python caches.
   - Contains only human-authored source files, configurations (`package.json`, `package-lock.json`, `tsconfig.json`, `build.mjs`), and documentation.

### Notes for AMO Reviewers (Copy & Paste to Reviewer Comments)

```text
Build Environment:
- OS: Windows, Linux, or macOS
- Node.js: 20 LTS (or newer)
- npm: 10 (or newer)

Reproduction Steps:
1. Extract ytdlp-bridge-2.0.0-source.zip
2. cd extension
3. npm ci
4. npm run build
5. The resulting files in extension/dist/ are byte-for-byte identical (unminified ES bundles) to the submitted add-on.
```

### Checked against Mozilla's current policies:

* **Remotely hosted code** — None. Everything the extension runs ships in the package; nothing is fetched, eval'd, or injected at runtime.
* **Data Collection / Permissions** — The manifest specifies `"data_collection_permissions": { "required": ["none"] }`. The add-on collects no user data, no analytics, no telemetry, and reads no cookies.
* **InnerHTML Safety** — Zero assignments to `innerHTML`. All DOM rendering uses safe `document.createElement`, `textContent`, and `dataset` properties.
* **Minification** — The build is deliberately unminified (`minify: false` in `build.mjs`) so AMO reviewers can read the shipped code directly.
* **Native messaging** — The helper is installed by the user through native scripts (`install.bat` / `install-windows.ps1` / `install-linux.sh` / `install-macos.sh`). The extension manifest pins the native messaging host `ytdlp_bridge` and allowed extension ID `ytdlp-bridge@kcgamingtech`.
