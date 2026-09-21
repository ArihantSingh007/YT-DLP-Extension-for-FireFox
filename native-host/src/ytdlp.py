"""Everything that knows about yt-dlp: where it is, how to call it, how to read
its output. No shell is used anywhere in this file."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys

IS_WINDOWS = sys.platform.startswith("win")
NO_WINDOW = 0x08000000 if IS_WINDOWS else 0

PROG, POST, FILE = "@@PROG@@", "@@POST@@", "@@FILE@@"
PROGRESS_TEMPLATE = ("download:" + PROG +
                     "%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|"
                     "%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s")
POST_TEMPLATE = "postprocess:" + POST + "%(progress.postprocessor)s|%(progress.status)s"
PRINT_TEMPLATE = "after_move:" + FILE + "%(filepath)s"
DEFAULT_TEMPLATE = "%(title)s [%(id)s].%(ext)s"

_DEST = re.compile(r"^\[(?:download|ExtractAudio|Merger)\]\s+(?:Destination|Merging formats into):?\s+\"?(.+?)\"?$")
_STAGES = ("Merger", "ExtractAudio", "Metadata", "EmbedThumbnail", "VideoConvertor")


class ToolError(Exception):
    def __init__(self, code: str, message: str, detail: str = ""):
        super().__init__(message)
        self.code, self.message, self.detail = code, message, detail


def config_dir() -> str:
    if IS_WINDOWS:
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    elif sys.platform == "darwin":
        base = os.path.join(os.path.expanduser("~"), "Library", "Application Support")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "ytdlp-bridge")


def downloads_dir() -> str:
    if IS_WINDOWS:
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as key:
                val, _ = winreg.QueryValueEx(key, "{374DE290-123F-4565-9164-39C4925E467B}")
                candidate = os.path.expandvars(str(val))
                if os.path.isdir(candidate):
                    return candidate
        except OSError:
            pass
    candidate = os.path.join(os.path.expanduser("~"), "Downloads")
    return candidate if os.path.isdir(candidate) else os.path.expanduser("~")


def _candidates(stem: str):
    home = os.path.expanduser("~")
    if IS_WINDOWS:
        local = os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData", "Local"))
        files = os.environ.get("ProgramFiles", r"C:\Program Files")
        roots = [os.path.join(local, "Microsoft", "WinGet", "Links"), os.path.join(local, "Programs", stem),
                 os.path.join(home, "scoop", "shims"), r"C:\ProgramData\chocolatey\bin",
                 os.path.join(files, stem, "bin"), os.path.join(files, stem), config_dir()]
        return [os.path.join(root, stem + ".exe") for root in roots]
    roots = ["/usr/local/bin", "/usr/bin", "/bin", "/snap/bin", "/opt/homebrew/bin",
             os.path.join(home, ".local", "bin"), os.path.join(home, "bin")]
    return [os.path.join(root, stem) for root in roots]


def find(stem: str, configured: str = "") -> str:
    """Configured path, then PATH, then the usual per-OS install locations."""
    if configured:
        expanded = os.path.expandvars(os.path.expanduser(configured))
        if os.path.isfile(expanded) and os.access(expanded, os.X_OK):
            return os.path.abspath(expanded)
    found = shutil.which(stem)
    if found:
        return os.path.abspath(found)
    for candidate in _candidates(stem):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return ""


def version_of(executable: str, flag: str = "--version") -> str:
    if not executable:
        return ""
    try:
        done = subprocess.run([executable, flag], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, timeout=20, creationflags=NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        return ""
    line = done.stdout.decode("utf-8", "replace").strip().splitlines()
    if not line:
        return ""
    first = line[0]
    return first.split(" ", 2)[2].split(" ")[0] if first.lower().startswith("ffmpeg version ") else first


def info_args(ytdlp: str, url: str, cookies_browser: str = ""):
    args = [ytdlp, "--dump-single-json", "--no-playlist", "--no-warnings", "--no-progress",
            "--no-colors", "--ignore-config", "--socket-timeout", "20", "--retries", "3"]
    if cookies_browser and cookies_browser != "none":
        args += ["--cookies-from-browser", cookies_browser]
    return args + ["--", url]


def download_args(job: dict, ytdlp: str, ffmpeg: str):
    retries = str(job.get("retries") or 5)
    args = [ytdlp, "--ignore-config", "--no-colors", "--newline", "--no-warnings", "--no-playlist",
            "--socket-timeout", "20", "--retries", retries, "--fragment-retries", "10", "--trim-filenames", "200",
            "--progress-template", PROGRESS_TEMPLATE, "--progress-template", POST_TEMPLATE,
            "--print", PRINT_TEMPLATE, "--no-simulate",
            "--paths", job["dir"], "-o", job["template"]]
    if IS_WINDOWS:
        args.append("--windows-filenames")
    # Unicode titles are kept; only characters the filesystem rejects are
    # stripped, and very long names are trimmed rather than failing.
    args.append("--force-overwrites" if job.get("overwrite") == "overwrite" else "--no-overwrites")
    if ffmpeg:
        args += ["--ffmpeg-location", ffmpeg]

    # Media & Metadata Embedding
    if job.get("embedMetadata", True):
        args.append("--embed-metadata")
    if job.get("embedThumbnail"):
        args.append("--embed-thumbnail")
    if job.get("embedChapters", True):
        args.append("--embed-chapters")

    # Subtitles & Captions
    if job.get("writeSubtitles"):
        args.append("--write-subs")
    if job.get("writeAutoSubtitles"):
        args.append("--write-auto-subs")
    if job.get("embedSubtitles"):
        args.append("--embed-subs")
    if job.get("subLangs"):
        args += ["--sub-langs", job["subLangs"]]
    if job.get("subFormat") and job["subFormat"] != "best":
        args += ["--convert-subs", job["subFormat"]]

    # SponsorBlock
    sb_remove = job.get("sponsorblockRemove")
    if sb_remove and sb_remove != "off":
        args += ["--sponsorblock-remove", sb_remove]
    sb_mark = job.get("sponsorblockMark")
    if sb_mark and sb_mark != "off":
        args += ["--sponsorblock-mark", sb_mark]

    # Network & Performance
    if job.get("rateLimit"):
        args += ["--limit-rate", job["rateLimit"]]
    if job.get("concurrentFragments") and int(job.get("concurrentFragments") or 1) > 1:
        args += ["--concurrent-fragments", str(job["concurrentFragments"])]
    if job.get("proxy"):
        args += ["--proxy", job["proxy"]]

    # Authentication & Cookies
    cookies = job.get("cookiesBrowser")
    if cookies and cookies != "none":
        args += ["--cookies-from-browser", cookies]

    # Mode / format
    if job["mode"] == "audio":
        args += ["-f", job["format"], "-x", "--audio-format", job["audioFormat"]]
        if job["audioFormat"] != "best":
            args += ["--audio-quality", "0" if job["audioQuality"] == "best" else str(job["audioQuality"]) + "K"]
        if job.get("keepVideo"):
            args.append("--keep-video")
    else:
        args += ["-f", job["format"]]
        if job.get("container"):
            args += ["--merge-output-format", job["container"]]

    # Extra arguments (already sanitized by validate.custom_args)
    if job.get("customArgs"):
        args += job["customArgs"]

    return args + ["--", job["url"]]


def parse_line(line: str):
    """One line of yt-dlp output -> an event dict, or None if uninteresting."""
    if line.startswith(PROG):
        parts = (line[len(PROG):].split("|") + [""] * 6)[:6]
        status, done, total, estimate, speed, eta = parts

        def number(value):
            try:
                return None if value in ("", "NA", "None") else float(value)
            except ValueError:
                return None

        downloaded, total_bytes = number(done), number(total) or number(estimate)
        percent = min(100.0, downloaded / total_bytes * 100.0) if downloaded is not None and total_bytes else None
        return {"kind": "progress", "status": status or "downloading", "downloadedBytes": downloaded,
                "totalBytes": total_bytes, "speed": number(speed), "eta": number(eta), "percent": percent}
    if line.startswith(POST):
        parts = line[len(POST):].split("|")
        return {"kind": "stage", "stage": parts[0]}
    if line.startswith(FILE):
        return {"kind": "file", "filepath": line[len(FILE):].strip()}
    match = _DEST.match(line.strip())
    if match:
        return {"kind": "file", "filepath": match.group(1).strip()}
    if line.startswith("[") and "]" in line and line[1:line.index("]")] in _STAGES:
        return {"kind": "stage", "stage": line[1:line.index("]")]}
    return None


def classify(stderr: str, exit_code: int):
    text = (stderr or "").lower()
    if "requested format is not available" in text or "no video formats" in text:
        return "FORMAT_UNAVAILABLE", "That quality is no longer available."
    if "video unavailable" in text or "this video is not available" in text:
        return "VIDEO_UNAVAILABLE", "This video is unavailable."
    if "private video" in text or "sign in" in text or "members-only" in text or "age" in text and "restrict" in text:
        return "AUTH_REQUIRED", "This video needs a signed-in YouTube session."
    if "ffmpeg" in text and "not found" in text:
        return "FFMPEG_MISSING", "FFmpeg is required for this download."
    if "urlopen error" in text or "timed out" in text or "unable to download" in text:
        return "NETWORK_ERROR", "The download failed because of a network problem."
    return "FAILED", "yt-dlp could not download this video."


def run_json(args, timeout: int = 120) -> dict:
    done = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=timeout, creationflags=NO_WINDOW)
    if done.returncode != 0:
        stderr = done.stderr.decode("utf-8", "replace")
        code, message = classify(stderr, done.returncode)
        raise ToolError(code, message, stderr.strip()[-800:])
    try:
        return json.loads(done.stdout.decode("utf-8", "replace"))
    except ValueError as cause:
        raise ToolError("FAILED", "yt-dlp returned output that could not be read.", str(cause))


def open_folder(target: str) -> bool:
    if not os.path.exists(target):
        parent = os.path.dirname(target)
        if os.path.isdir(parent):
            target = parent
        else:
            return False
    try:
        if IS_WINDOWS:
            normalised = os.path.normpath(target)
            folder = os.path.dirname(normalised) if os.path.isfile(normalised) else normalised
            if os.path.isfile(normalised):
                # Windows explorer /select,"<path>" fails when path contains characters like '#', '(', ')', '[', ']'
                # which causes Explorer to fall back to opening Documents!
                # Using 8.3 short paths resolves this completely.
                try:
                    import ctypes
                    buf = ctypes.create_unicode_buffer(1024)
                    if ctypes.windll.kernel32.GetShortPathNameW(normalised, buf, 1024) > 0 and buf.value:
                        subprocess.Popen(f'explorer /select,"{buf.value}"')
                        return True
                except Exception:
                    pass
                # Safe fallback: open the parent folder directly (never drops to Documents)
                try:
                    os.startfile(folder)
                    return True
                except OSError:
                    subprocess.Popen(f'explorer "{folder}"')
                    return True
            else:
                try:
                    os.startfile(folder)
                    return True
                except OSError:
                    subprocess.Popen(f'explorer "{folder}"')
                    return True
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", target] if os.path.isfile(target) else ["open", target])
        else:
            subprocess.Popen(["xdg-open", target if os.path.isdir(target) else os.path.dirname(target)])
        return True
    except OSError:
        return False


def open_file(target: str) -> bool:
    if not os.path.isfile(target):
        return False
    try:
        if IS_WINDOWS:
            normalised = os.path.normpath(target)
            os.startfile(normalised)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", target])
        else:
            subprocess.Popen(["xdg-open", target])
        return True
    except OSError:
        return False

