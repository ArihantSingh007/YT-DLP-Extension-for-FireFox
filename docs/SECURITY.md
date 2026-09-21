# Security model

Two facts have to be kept apart: a YouTube page is hostile, and the helper can
start a process.

## What a page can do

A content script can send the background page exactly four messages: `info`,
`deps`, `download`, `cancel`. Anything else from a tab is refused with
`FORBIDDEN`. The page never sees the native port, and the download URL is
re-parsed from `location.href` and re-canonicalised in the background before it
reaches the helper.

## What the helper accepts

| Field | Rule |
|---|---|
| action | one of seven known names |
| id / jobId | `[A-Za-z0-9_-]{1,64}` |
| url | http(s), host in the YouTube allow-list, passed after `--` |
| format selector | `^[A-Za-z0-9_.,:+/*\[\]()=<>?~^-]{1,200}$` — no spaces, quotes, backticks, `;`, `&`, `\|`, `$` or newlines |
| audio format / bitrate / container / overwrite | fixed enumerations |
| filename template | yt-dlp field syntax only, `..` rejected |
| output folder | `realpath`-resolved, must sit inside the allowed roots |
| frame length | 0 or >1 MB stops the reader instead of desynchronising the stream |
| frame body | unreadable JSON inside a valid frame is reported, and the host keeps running |
| tool paths | settable only from the settings page; must exist and be executable |

Unknown JSON fields are ignored rather than fatal, so a newer yt-dlp cannot
crash anything.

## Process execution

`subprocess.Popen([...])` with an argument array. No `shell=True`, no string
concatenation, no `eval`, no arbitrary executable path from a page. On Windows a
cancel runs `taskkill /F /T` against that one PID; elsewhere the process group of
that one job. Partial `.part`/`.ytdl` files from a cancelled job are removed.

## Credentials and DRM

No cookies, tokens or session data are read, stored or forwarded — the extension
holds no cookie permission and the helper is never given one. Protected content
is reported as an error, never circumvented.

## Updates

Nothing in this project downloads, installs, updates or replaces any executable.
Python, yt-dlp and FFmpeg are installed by you, by hand. The only thing the
install script writes is the Native Messaging registration Firefox requires: one
JSON file next to the script and one `HKCU` value pointing at it. No PATH
changes, no Defender or SmartScreen changes, no administrator rights.

## Logging

Request id, action, exit code and error category only. stdout is reserved for
protocol messages, so diagnostics can never corrupt a reply.
