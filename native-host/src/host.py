#!/usr/bin/env python3
"""ytdlp-bridge native messaging host.

Reads JSON from stdin, writes JSON to stdout, and does nothing at all between
requests. Diagnostics go to a log file; stdout is protocol-only.
"""
from __future__ import annotations

import json
import logging
import os
import struct
import sys
import threading
import traceback
from logging.handlers import RotatingFileHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import validate          # noqa: E402
import ytdlp             # noqa: E402
from jobs import Jobs    # noqa: E402
from validate import Invalid  # noqa: E402

VERSION = "2.0.0"
MAX_MESSAGE = 1024 * 1024
CONFIG_FILE = os.path.join(ytdlp.config_dir(), "config.json")

write_lock = threading.Lock()
log = logging.getLogger("ytdlp-bridge")

# ------------------------------------------------------------------ plumbing

def setup_logging() -> None:
    os.makedirs(ytdlp.config_dir(), exist_ok=True)
    handler = RotatingFileHandler(os.path.join(ytdlp.config_dir(), "native-host.log"),
                                  maxBytes=256 * 1024, backupCount=1, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(handler)
    log.setLevel(logging.INFO)


class Framing(Exception):
    """The stream is no longer trustworthy - stop reading."""


def read_message():
    """Return the next message, or None at end of input.

    A length header we cannot honour means the stream is desynchronised, so we
    stop instead of reading garbage. A readable frame with bad JSON inside is
    recoverable: the body has been consumed, so we report and carry on.
    """
    header = sys.stdin.buffer.read(4)
    if not header or len(header) < 4:
        return None
    (length,) = struct.unpack("@I", header)
    if length == 0 or length > MAX_MESSAGE:
        raise Framing(f"message length out of range: {length}")
    body = sys.stdin.buffer.read(length)
    if body is None or len(body) < length:
        raise Framing("truncated message body")
    message = json.loads(body.decode("utf-8", "replace"))
    if not isinstance(message, dict):
        raise ValueError("message must be an object")
    return message


def write_message(message: dict) -> None:
    data = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with write_lock:
        sys.stdout.buffer.write(struct.pack("@I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def load_config() -> dict:
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as handle:
            stored = json.load(handle)
        return stored if isinstance(stored, dict) else {}
    except (OSError, ValueError):
        return {}


def save_config(patch: dict) -> dict:
    config = load_config()
    config.update(patch)
    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)
    return config


def roots() -> list:
    config = load_config()
    values = [config.get("downloadDirectory") or "", ytdlp.downloads_dir(), os.path.expanduser("~")]
    return [value for value in values if value]


def default_dir() -> str:
    configured = load_config().get("downloadDirectory") or ""
    return configured if os.path.isdir(os.path.expanduser(configured)) else ytdlp.downloads_dir()


jobs = Jobs(emit=write_message)

# ------------------------------------------------------------------- actions

def status(_request: dict) -> dict:
    config = load_config()
    ytdlp_path = ytdlp.find("yt-dlp", config.get("ytdlpPath", ""))
    ffmpeg_path = ytdlp.find("ffmpeg", config.get("ffmpegPath", ""))
    ytdlp_version = ytdlp.version_of(ytdlp_path)
    return {
        "hostVersion": VERSION,
        "python": sys.version.split()[0],
        "ytdlp": {"found": bool(ytdlp_version), "path": ytdlp_path or None, "version": ytdlp_version or None},
        "ffmpeg": {"found": bool(ffmpeg_path), "path": ffmpeg_path or None,
                   "version": ytdlp.version_of(ffmpeg_path, "-version") or None},
        "downloadDirectory": default_dir(),
        "logFile": os.path.join(ytdlp.config_dir(), "native-host.log"),
    }


def require_ytdlp() -> str:
    path = ytdlp.find("yt-dlp", load_config().get("ytdlpPath", ""))
    if not path:
        raise ytdlp.ToolError("NO_YTDLP", "yt-dlp is not installed.")
    return path


def get_info(request: dict) -> dict:
    url = validate.url(request.get("url"))
    data = ytdlp.run_json(ytdlp.info_args(require_ytdlp(), url))
    return {
        "id": data.get("id"), "title": data.get("title"),
        "uploader": data.get("uploader") or data.get("channel"),
        "duration": data.get("duration"), "thumbnail": data.get("thumbnail"),
        "isLive": bool(data.get("is_live")), "webpageUrl": data.get("webpage_url") or url,
        "formats": data.get("formats") or [],
    }


def download(request: dict) -> dict:
    config = load_config()
    mode = validate.choice(request.get("mode"), {"video", "audio"}, "mode", "video")
    audio_format = validate.choice(request.get("audioFormat"), validate.AUDIO_FORMATS, "audio format", "best")
    ffmpeg_path = ytdlp.find("ffmpeg", config.get("ffmpegPath", ""))
    selector = validate.selector(request.get("format") or ("bestaudio/best" if mode == "audio" else "bestvideo*+bestaudio/best"))

    needs_ffmpeg = (mode == "audio" and audio_format in {"mp3"}) or (mode == "video" and "+" in selector)
    if needs_ffmpeg and not ffmpeg_path:
        raise Invalid("FFMPEG_MISSING", "FFmpeg is required for this download.")

    directory = validate.directory(request.get("outputDirectory"), roots(), default_dir())
    os.makedirs(directory, exist_ok=True)

    spec = {
        "id": validate.request_id(request.get("jobId")),
        "url": validate.url(request.get("url")),
        "mode": mode,
        "format": selector,
        "audioFormat": audio_format,
        "audioQuality": validate.choice(request.get("audioQuality"), validate.AUDIO_QUALITY, "bitrate", "best"),
        "container": validate.choice(request.get("mergeOutputFormat"), validate.CONTAINERS, "container", "") or None,
        "overwrite": validate.choice(request.get("overwrite"), validate.OVERWRITE, "overwrite policy", "never"),
        "template": validate.template(request.get("outputTemplate"), ytdlp.DEFAULT_TEMPLATE),
        "dir": directory,
        "maxConcurrent": request.get("maxConcurrent", 2),
        "ytdlp": require_ytdlp(),
        "ffmpeg": ffmpeg_path,
    }
    return jobs.start(spec)


def cancel(request: dict) -> dict:
    job_id = validate.request_id(request.get("jobId"))
    return {"cancelled": jobs.cancel(job_id)}


def open_folder(request: dict) -> dict:
    raw = str(request.get("path") or "")
    folder = raw if os.path.isdir(os.path.expanduser(raw)) else os.path.dirname(os.path.expanduser(raw))
    resolved = validate.directory(folder, roots(), default_dir())
    target = os.path.expanduser(raw) if os.path.isfile(os.path.expanduser(raw)) else resolved
    return {"opened": ytdlp.open_folder(target)}


def set_config(request: dict) -> dict:
    patch = {
        "ytdlpPath": validate.executable(request.get("ytdlpPath"), "yt-dlp"),
        "ffmpegPath": validate.executable(request.get("ffmpegPath"), "FFmpeg"),
    }
    folder = request.get("downloadDirectory") or ""
    if folder:
        expanded = os.path.abspath(os.path.expanduser(str(folder)))
        if not os.path.isdir(expanded):
            raise Invalid("BAD_PATH", "That download folder does not exist.")
        patch["downloadDirectory"] = expanded
    else:
        patch["downloadDirectory"] = ""
    save_config(patch)
    return status(request)


HANDLERS = {
    "ping": lambda request: {"pong": True, "hostVersion": VERSION},
    "get_status": status,
    "get_info": get_info,
    "download": download,
    "cancel": cancel,
    "open_folder": open_folder,
    "set_config": set_config,
}
# Actions that shell out run on their own thread so a slow metadata lookup
# never blocks a cancel request.
THREADED = {"get_status", "get_info", "open_folder", "set_config"}


def handle(message: dict) -> None:
    try:
        request_id = validate.request_id(message.get("id"))
        action = validate.action(message.get("action"))
    except Invalid as error:
        write_message({"id": message.get("id"), "success": False,
                       "error": {"code": error.code, "message": error.message}})
        return

    def run() -> None:
        try:
            write_message({"id": request_id, "success": True, "data": HANDLERS[action](message)})
        except Invalid as error:
            write_message({"id": request_id, "success": False,
                           "error": {"code": error.code, "message": error.message}})
        except ytdlp.ToolError as error:
            write_message({"id": request_id, "success": False,
                           "error": {"code": error.code, "message": error.message, "detail": error.detail}})
        except Exception as error:  # pragma: no cover
            log.error("action %s failed: %s\n%s", action, error, traceback.format_exc())
            write_message({"id": request_id, "success": False,
                           "error": {"code": "FAILED", "message": "The helper hit an unexpected error.",
                                     "detail": str(error)}})

    log.info("request %s %s", request_id, action)
    if action in THREADED:
        threading.Thread(target=run, name=action, daemon=True).start()
    else:
        run()


def main() -> int:
    if ytdlp.IS_WINDOWS:
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    setup_logging()
    log.info("host %s started", VERSION)
    try:
        while True:
            try:
                message = read_message()
            except ValueError as error:          # bad JSON inside a valid frame
                log.error("bad message: %s", error)
                write_message({"id": None, "success": False,
                               "error": {"code": "BAD_REQUEST", "message": "Malformed message."}})
                continue
            except Framing as error:             # unusable stream
                log.error("framing error, stopping: %s", error)
                break
            if message is None:
                break
            handle(message)
    except KeyboardInterrupt:
        pass
    finally:
        jobs.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
