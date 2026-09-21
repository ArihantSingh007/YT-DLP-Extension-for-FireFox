# Troubleshooting

## "Setup required" / helper not installed

Double-click `native-host\install.bat`, then restart Firefox — Firefox reads the
registration only at startup. If the script says Python was not found, install
Python 3.9+ first (see SETUP.md); the helper is a Python program.

Check it by hand if needed:

```powershell
reg query "HKCU\Software\Mozilla\NativeMessagingHosts\com.kcgamingtech.ytdlp_bridge"
```

The value must point at an existing `manifest.json` whose `path` is the helper
executable and whose `allowed_extensions` contains `ytdlp-bridge@kcgamingtech`.
Moved the folder after installing? Run the installer again.

## "yt-dlp is not installed"

Install yt-dlp (see SETUP.md), or put the full path into Settings → Advanced →
yt-dlp path, then press **Test setup**.

## "FFmpeg is required"

1080p and above are separate video and audio streams, so joining them needs
FFmpeg, as does MP3. Install FFmpeg (see SETUP.md), or pick M4A/Opus for music or
a quality that already includes audio.

## No Download button

* Confirm the page is `/watch`, `/shorts/` or `/live/`.
* Reload the tab: the button is re-placed on every YouTube navigation event.
* The extension only runs on `www.youtube.com` and `music.youtube.com`.

## Progress sits at 100%

That is FFmpeg merging or converting; the dialog title changes to "Merging video
and audio" or "Converting audio". Large 4K merges take a minute.

## "Sign-in required"

Private, members-only and age-restricted videos fail on purpose: the extension
never reads your cookies or YouTube session.

## Downloads stop when Firefox closes

The helper is a child process of Firefox. Quitting Firefox ends it, and the
queue lives in the extension.

## Logs

`%APPDATA%\ytdlp-bridge\native-host.log` (Linux `~/.config/ytdlp-bridge/`,
macOS `~/Library/Application Support/ytdlp-bridge/`). It contains request ids,
action names and error categories — never cookies, tokens or personal data.

## Start over

`powershell -ExecutionPolicy Bypass -File native-host\install-windows.ps1 -Uninstall`,
delete `%APPDATA%\ytdlp-bridge`, reinstall.
