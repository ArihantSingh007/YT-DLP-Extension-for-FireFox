"""Input validation. Everything from the browser is untrusted."""
from __future__ import annotations

import os
import re
from urllib.parse import urlparse

ACTIONS = {"ping", "get_status", "get_info", "download", "cancel", "open_folder", "open_file", "set_config"}
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

SUB_FORMATS = {"best", "srt", "vtt", "ass", "lrc"}
SPONSORBLOCK_REMOVE = {"off", "sponsor", "sponsor,selfpromo", "sponsor,selfpromo,interaction", "all"}
SPONSORBLOCK_MARK = {"off", "sponsor", "all"}
COOKIES_BROWSERS = {"none", "firefox", "chrome", "edge", "brave", "chromium", "vivaldi", "opera", "safari"}

RATE_LIMIT_RE = re.compile(r"^[0-9]+(\.[0-9]+)?[KkMmGg]?$")
SUB_LANGS_RE = re.compile(r"^[A-Za-z0-9_.*,-]{1,100}$")
SAFE_ARG_RE = re.compile(r"^[A-Za-z0-9_.,:+=/\\~^ -]{1,200}$")

DISALLOWED_ARGS = {
    "--exec", "--exec-before-download", "--config-location",
    "--load-info-json", "--cookies", "--batch-file", "--external-downloader"
}


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


def boolean(value, default: bool = False) -> bool:
    if value is None:
        return default
    return bool(value)


def integer_range(value, low: int, high: int, default: int) -> int:
    if value in (None, ""):
        return default
    try:
        val = int(value)
        return max(low, min(high, val))
    except (TypeError, ValueError):
        return default


def rate_limit(value) -> str:
    if not value or not isinstance(value, str):
        return ""
    val = value.strip()
    if not val or not RATE_LIMIT_RE.match(val):
        return ""
    return val


def sub_langs(value) -> str:
    if not value or not isinstance(value, str):
        return "en.*,all"
    val = value.strip()
    if not val or not SUB_LANGS_RE.match(val):
        return "en.*,all"
    return val


def proxy(value) -> str:
    if not value or not isinstance(value, str):
        return ""
    val = value.strip()
    parsed = urlparse(val)
    if parsed.scheme in ("http", "https", "socks4", "socks5") and parsed.netloc:
        return val
    return ""


def custom_args(value) -> list[str]:
    if not value or not isinstance(value, str):
        return []
    import shlex
    try:
        tokens = shlex.split(value)
    except ValueError:
        return []

    safe_tokens: list[str] = []
    skip_next = False
    expect_value = False

    for token in tokens:
        if skip_next:
            skip_next = False
            continue

        lower = token.lower()
        if any(lower == dis for dis in DISALLOWED_ARGS):
            skip_next = True
            expect_value = False
            continue
        if any(lower.startswith(dis + "=") for dis in DISALLOWED_ARGS):
            expect_value = False
            continue

        if any(ch in token for ch in (";", "&", "|", "`", "$", "<", ">", "\n", "\r", "(", ")")):
            expect_value = False
            continue

        if not SAFE_ARG_RE.match(token):
            expect_value = False
            continue

        if token.startswith("-"):
            safe_tokens.append(token)
            expect_value = not ("=" in token)
        elif expect_value:
            safe_tokens.append(token)
            expect_value = False

    return safe_tokens

