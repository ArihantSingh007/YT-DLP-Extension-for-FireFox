"""Input validation. Everything from the browser is untrusted."""
from __future__ import annotations

import os
import re
from urllib.parse import urlparse

ACTIONS = {"ping", "get_status", "get_info", "download", "cancel", "open_folder", "set_config"}
HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# The characters yt-dlp's selector grammar actually uses - no spaces, quotes,
# backticks, ; & | $ < > or newlines, so nothing can become a second command.
SELECTOR_RE = re.compile(r"^[A-Za-z0-9_.,:+/*\[\]()=<>?~^-]{1,200}$")
TEMPLATE_RE = re.compile(r"^[A-Za-z0-9 %()._,#&'\[\]{}+-]{1,200}$")

AUDIO_FORMATS = {"best", "m4a", "mp3", "opus"}
AUDIO_QUALITY = {"best", "320", "256", "192", "128"}
CONTAINERS = {"mp4", "mkv", "webm"}
# yt-dlp has no auto-rename mode, so only these two are offered.
OVERWRITE = {"never", "overwrite"}


class Invalid(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def request_id(value) -> str:
    if not isinstance(value, str) or not ID_RE.match(value):
        raise Invalid("BAD_REQUEST", "Malformed request id.")
    return value


def action(value) -> str:
    if value not in ACTIONS:
        raise Invalid("BAD_REQUEST", f"Unsupported action: {value!r}")
    return value


def url(value) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        raise Invalid("BAD_URL", "The video URL is missing or too long.")
    parsed = urlparse(value.strip())
    if parsed.scheme not in ("http", "https") or (parsed.hostname or "").lower() not in HOSTS:
        raise Invalid("BAD_URL", "That URL is not a YouTube address.")
    return value.strip()


def selector(value) -> str:
    if not isinstance(value, str) or not SELECTOR_RE.match(value):
        raise Invalid("BAD_REQUEST", "The requested format is not valid.")
    return value


def choice(value, allowed: set, name: str, default: str) -> str:
    if value in (None, ""):
        return default
    if not isinstance(value, str) or value not in allowed:
        raise Invalid("BAD_REQUEST", f"Invalid {name}.")
    return value


def template(value, default: str) -> str:
    if value in (None, ""):
        return default
    if not isinstance(value, str) or not TEMPLATE_RE.match(value) or ".." in value:
        raise Invalid("BAD_REQUEST", "The filename template contains unsupported characters.")
    return value


def _inside(child: str, parent: str) -> bool:
    try:
        return os.path.commonpath([os.path.realpath(child), os.path.realpath(parent)]) == os.path.realpath(parent)
    except ValueError:
        return False


def directory(value, roots, default: str) -> str:
    """Resolve a download folder and keep it inside the allowed roots."""
    if value in (None, ""):
        target = default
    else:
        if not isinstance(value, str) or len(value) > 512:
            raise Invalid("BAD_PATH", "That download folder is not valid.")
        target = os.path.expandvars(os.path.expanduser(value))
    target = os.path.abspath(target)
    for root in roots:
        root = os.path.abspath(os.path.expanduser(root))
        if target == root or _inside(target, root):
            return target
    raise Invalid("BAD_PATH", "That folder is outside the folders this helper may write to.")


def executable(value, name: str):
    if value in (None, ""):
        return ""
    if not isinstance(value, str) or len(value) > 512:
        raise Invalid("BAD_PATH", f"The {name} path is not valid.")
    path = os.path.abspath(os.path.expandvars(os.path.expanduser(value)))
    if not os.path.isfile(path) or not os.access(path, os.X_OK):
        raise Invalid("BAD_PATH", f"No program was found at that {name} path.")
    return path
