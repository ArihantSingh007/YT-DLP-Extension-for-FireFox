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

```bash
cd extension
npm run package        # -> web-ext-artifacts/ytdlp-bridge-<version>.zip
```

The zip contains only `dist/`: four bundles, two HTML pages, one stylesheet, the
manifest and the icons. No tests, no Python, no scripts, no binaries, no source
maps.

Checked against Mozilla's current rules:

* **Remotely hosted code** — none. Everything the extension runs ships in the
  package; nothing is fetched or evaluated at runtime.
* **Minification** — the build is deliberately *not* minified, because AMO
  reviewers must be able to read the shipped code. esbuild still bundles (content
  scripts cannot use ES module imports), so attach the repository as the source
  package with these build instructions: `npm ci && npm run build`, output in
  `extension/dist`. esbuild and TypeScript are open source and run locally, which
  is what Mozilla requires of build tools.
* **Native messaging** — allowed. The helper is installed by the user through the
  OS, never by the add-on, and the manifest's `allowed_extensions` pins the
  extension ID, which is why the ID must stay `ytdlp-bridge@kcgamingtech` in
  `public/manifest.json` and in the helper manifest written by the install script.
* **Data policy** — the only data leaving the extension is the current video URL,
  sent to the local helper, which is the add-on's stated primary function. No
  telemetry, no remote endpoints, no cookies, nothing stored from private windows.
* **Signing** — AMO signs the uploaded zip and handles updates. Unsigned builds
  can only be loaded temporarily via `about:debugging`, which is a development
  path, not a user path.
