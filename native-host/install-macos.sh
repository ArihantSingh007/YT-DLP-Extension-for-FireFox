#!/usr/bin/env bash
# Registers the yt-dlp bridge native messaging host with Firefox on macOS.
set -euo pipefail

HOST_NAME="com.kcgamingtech.ytdlp_bridge"
EXTENSION_ID="ytdlp-bridge@kcgamingtech"
HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="$HOST_DIR/run-host.sh"
TARGET_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$TARGET_DIR/$HOST_NAME.json"
  echo "Unregistered. Restart Firefox."
  exit 0
fi

command -v python3 >/dev/null || { echo "python3 is required."; exit 1; }
chmod +x "$LAUNCHER"
mkdir -p "$TARGET_DIR"

cat > "$TARGET_DIR/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "Runs the locally installed yt-dlp for the yt-dlp bridge Firefox extension.",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_extensions": ["$EXTENSION_ID"]
}
JSON

echo "[ ok ] manifest  $TARGET_DIR/$HOST_NAME.json"
echo "[ ok ] python3   $(command -v python3)"
if command -v yt-dlp >/dev/null; then
  echo "[ ok ] yt-dlp    $(command -v yt-dlp) ($(yt-dlp --version 2>/dev/null))"
else
  echo "[ !! ] yt-dlp    not on PATH - install it, or set the path in the extension settings"
fi
if command -v ffmpeg >/dev/null; then
  echo "[ ok ] ffmpeg    $(command -v ffmpeg)"
else
  echo "[ !! ] ffmpeg    not on PATH - needed for merging and MP3 conversion"
fi
echo
echo "Restart Firefox, then load extension/dist/manifest.json from about:debugging."
