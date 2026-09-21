#!/usr/bin/env bash
# Linux/macOS launcher for the native messaging host.
set -euo pipefail
HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${YTDLP_BRIDGE_PYTHON:-$(command -v python3 || command -v python)}"
exec "$PYTHON" "$HOST_DIR/src/host.py"
