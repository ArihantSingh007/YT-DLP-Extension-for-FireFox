# Setup guide (for users)

You need four things. The extension installs one of them; you install the other
three yourself, once. The extension never installs software, changes PATH, or
touches your security settings.

## 1. Python 3.9 or newer

The helper that talks to yt-dlp is a small Python program.

* Windows: <https://www.python.org/downloads/> — during setup, tick
  **"Add python.exe to PATH"**.
* Check it worked: open a terminal and run `python --version`.

## 2. yt-dlp

<https://github.com/yt-dlp/yt-dlp#installation>

The simplest Windows route is the official release `yt-dlp.exe`. Put it in a
folder that is on your PATH, or note where you saved it — you can type the full
path into the extension's settings instead.

Check: `yt-dlp --version`.

## 3. FFmpeg

<https://ffmpeg.org/download.html>

Needed for 1080p and above (YouTube serves video and audio separately at those
qualities) and for MP3. Without it you can still download up to 720p and use
M4A/Opus.

Check: `ffmpeg -version`.

## 4. The helper registration

Firefox will not talk to a local program unless that program is registered in a
specific place. This is a Firefox security rule, not a choice this project made,
and it is the one step that needs a script.

1. Download this project's folder.
2. Open `native-host` and **double-click `install.bat`**.
3. It prints what it found and writes the registration. Nothing else changes.
4. Restart Firefox.

Linux: run `native-host/install-linux.sh`. macOS: `native-host/install-macos.sh`.

To undo it later:
`powershell -ExecutionPolicy Bypass -File native-host\install-windows.ps1 -Uninstall`

## 5. Check it

Open the extension's settings (toolbar icon → Settings). You should see:

```
Local helper   Ready
Python         Python 3.x.x
yt-dlp         Detected 2026.xx.xx
FFmpeg         Detected
```

If something says "Not found", install it and press **Test setup**, or type its
full path under **Advanced**.

## Using it

Open a YouTube video → press **Download** next to Like/Share → choose **Video**
or **Music** → pick a quality → **Download**. Progress, cancel and the queue are
in the toolbar popup.

Problems? See [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
