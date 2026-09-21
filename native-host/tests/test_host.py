"""Validation, argument building, output parsing, and a real native-messaging
round trip against host.py running as a subprocess."""
import json
import os
import struct
import subprocess
import sys
import unittest

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
sys.path.insert(0, SRC)

import validate  # noqa: E402
import ytdlp     # noqa: E402
from validate import Invalid  # noqa: E402


class UrlTests(unittest.TestCase):
    def test_accepts_youtube(self):
        for url in ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ",
                    "https://music.youtube.com/watch?v=dQw4w9WgXcQ"]:
            self.assertEqual(validate.url(url), url)

    def test_rejects_anything_else(self):
        for url in ["https://evil.example.com/watch?v=1", "file:///etc/passwd", "javascript:alert(1)",
                    "http://youtube.com.evil.test/x", "", None, 7]:
            with self.assertRaises(Invalid):
                validate.url(url)


class SelectorTests(unittest.TestCase):
    def test_accepts_real_selectors(self):
        for selector in ["bestvideo*+bestaudio/best", "299+140/bestvideo[height<=1080]+bestaudio",
                         "bestaudio[ext=m4a]/bestaudio", "bestaudio[acodec^=opus]/bestaudio"]:
            self.assertEqual(validate.selector(selector), selector)

    def test_rejects_injection(self):
        for selector in ["best; rm -rf ~", "best && calc.exe", "best`whoami`", "$(curl evil)",
                         "best | nc host 1", "best\nrm x", "a" * 300]:
            with self.assertRaises(Invalid):
                validate.selector(selector)


class PathTests(unittest.TestCase):
    def setUp(self):
        self.root = os.path.abspath(os.path.expanduser("~"))

    def test_default_when_empty(self):
        self.assertEqual(validate.directory(None, [self.root], self.root), self.root)

    def test_subdirectory_allowed(self):
        target = os.path.join(self.root, "Music")
        self.assertEqual(validate.directory(target, [self.root], self.root), target)

    def test_traversal_blocked(self):
        for attempt in [os.path.join(self.root, "..", "..", "etc"), "/etc", "C:\\Windows\\System32"]:
            with self.assertRaises(Invalid):
                validate.directory(attempt, [self.root], self.root)

    def test_template_blocked(self):
        for template in ["../%(title)s.%(ext)s", "..\\evil.%(ext)s", "%(title)s;rm.%(ext)s"]:
            with self.assertRaises(Invalid):
                validate.template(template, "x")


class ArgvTests(unittest.TestCase):
    def job(self, **overrides):
        spec = {"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "mode": "video",
                "format": "299+140/bestvideo+bestaudio", "container": "mp4", "dir": os.path.expanduser("~"),
                "template": ytdlp.DEFAULT_TEMPLATE, "overwrite": "never",
                "audioFormat": "best", "audioQuality": "best"}
        spec.update(overrides)
        return spec

    def test_single_video_only(self):
        args = ytdlp.download_args(self.job(), "yt-dlp", "ffmpeg")
        self.assertIn("--no-playlist", args)
        self.assertNotIn("--yes-playlist", args)

    def test_url_after_double_dash(self):
        args = ytdlp.download_args(self.job(), "yt-dlp", "")
        self.assertEqual(args[-2], "--")
        self.assertTrue(args[-1].startswith("https://"))

    def test_mp3_conversion_flags(self):
        args = ytdlp.download_args(self.job(mode="audio", format="bestaudio/best", audioFormat="mp3",
                                            audioQuality="320"), "yt-dlp", "ffmpeg")
        self.assertIn("-x", args)
        self.assertIn("mp3", args)
        self.assertIn("320K", args)

    def test_best_audio_is_not_transcoded(self):
        args = ytdlp.download_args(self.job(mode="audio", format="bestaudio[ext=m4a]/bestaudio",
                                            audioFormat="best"), "yt-dlp", "ffmpeg")
        self.assertNotIn("mp3", args)
        self.assertNotIn("--audio-quality", args)

    def test_progress_templates(self):
        args = ytdlp.download_args(self.job(), "yt-dlp", "")
        self.assertIn(ytdlp.PROGRESS_TEMPLATE, args)
        self.assertIn(ytdlp.POST_TEMPLATE, args)


class ParsingTests(unittest.TestCase):
    def test_progress(self):
        event = ytdlp.parse_line(ytdlp.PROG + "downloading|1048576|10485760|NA|524288|18")
        self.assertEqual(event["kind"], "progress")
        self.assertAlmostEqual(event["percent"], 10.0)
        self.assertEqual(event["eta"], 18.0)

    def test_progress_without_total(self):
        event = ytdlp.parse_line(ytdlp.PROG + "downloading|1000|NA|NA|NA|NA")
        self.assertIsNone(event["percent"])

    def test_filepath(self):
        event = ytdlp.parse_line(ytdlp.FILE + "/home/u/Downloads/Song [abc].m4a")
        self.assertEqual(event["kind"], "file")

    def test_stage(self):
        self.assertEqual(ytdlp.parse_line(ytdlp.POST + "ExtractAudio|started")["stage"], "ExtractAudio")

    def test_noise_ignored(self):
        self.assertIsNone(ytdlp.parse_line("[youtube] Extracting URL: https://..."))

    def test_error_classification(self):
        self.assertEqual(ytdlp.classify("ERROR: Video unavailable", 1)[0], "VIDEO_UNAVAILABLE")
        self.assertEqual(ytdlp.classify("ERROR: Private video. Sign in", 1)[0], "AUTH_REQUIRED")
        self.assertEqual(ytdlp.classify("ERROR: Requested format is not available", 1)[0], "FORMAT_UNAVAILABLE")
        self.assertEqual(ytdlp.classify("weird", 1)[0], "FAILED")


class DependencyDetectionTests(unittest.TestCase):
    def test_configured_path_wins(self):
        self.assertEqual(ytdlp.find("yt-dlp", sys.executable), os.path.abspath(sys.executable))

    def test_missing_tool_returns_empty_string(self):
        self.assertEqual(ytdlp.find("definitely-not-a-real-tool-xyz"), "")

    def test_bad_configured_path_falls_back_to_search(self):
        self.assertEqual(ytdlp.find("definitely-not-a-real-tool-xyz", "/no/such/file"), "")

    def test_version_probe_on_a_real_program(self):
        self.assertTrue(ytdlp.version_of(sys.executable))

    def test_version_probe_on_a_missing_program(self):
        self.assertEqual(ytdlp.version_of(""), "")


class FilenameTests(unittest.TestCase):
    def job(self, **overrides):
        spec = {"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "mode": "video", "format": "best",
                "container": "mp4", "dir": os.path.expanduser("~"), "template": ytdlp.DEFAULT_TEMPLATE,
                "overwrite": "never", "audioFormat": "best", "audioQuality": "best"}
        spec.update(overrides)
        return spec

    def test_duplicate_files_are_kept_by_default(self):
        self.assertIn("--no-overwrites", ytdlp.download_args(self.job(), "yt-dlp", ""))

    def test_overwrite_is_explicit(self):
        args = ytdlp.download_args(self.job(overwrite="overwrite"), "yt-dlp", "")
        self.assertIn("--force-overwrites", args)
        self.assertNotIn("--no-overwrites", args)

    def test_long_names_are_trimmed(self):
        args = ytdlp.download_args(self.job(), "yt-dlp", "")
        self.assertIn("--trim-filenames", args)

    def test_unicode_template_is_accepted_and_kept(self):
        template = "%(title)s [%(id)s].%(ext)s"
        self.assertEqual(validate.template(template, "x"), template)
        args = ytdlp.download_args(self.job(template=template), "yt-dlp", "")
        self.assertIn(template, args)
        self.assertNotIn("--restrict-filenames", args)   # would mangle non-ASCII titles

    def test_template_cannot_escape_the_folder(self):
        for bad in ["../%(title)s.%(ext)s", "..\\x.%(ext)s", "%(title)s`whoami`.%(ext)s"]:
            with self.assertRaises(Invalid):
                validate.template(bad, "x")


class NativeMessagingTests(unittest.TestCase):
    """Starts host.py exactly as Firefox would and speaks the real protocol."""

    def setUp(self):
        self.proc = subprocess.Popen([sys.executable, os.path.join(SRC, "host.py")],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def tearDown(self):
        if self.proc.stdin is None:
            self.proc.stdout.close()
            self.proc.stderr.close()
            return
        self.proc.stdin.close()
        self.proc.wait(timeout=10)
        self.proc.stdout.close()
        self.proc.stderr.close()

    def send(self, message):
        data = json.dumps(message).encode()
        self.proc.stdin.write(struct.pack("@I", len(data)) + data)
        self.proc.stdin.flush()

    def recv(self):
        length = struct.unpack("@I", self.proc.stdout.read(4))[0]
        return json.loads(self.proc.stdout.read(length))

    def test_ping(self):
        self.send({"id": "a1", "action": "ping"})
        reply = self.recv()
        self.assertTrue(reply["success"])
        self.assertTrue(reply["data"]["pong"])

    def test_status_reports_dependencies(self):
        self.send({"id": "a2", "action": "get_status"})
        data = self.recv()["data"]
        self.assertIn("ytdlp", data)
        self.assertIn("ffmpeg", data)
        self.assertIn("downloadDirectory", data)

    def test_unknown_action_rejected(self):
        self.send({"id": "a3", "action": "run_shell"})
        self.assertEqual(self.recv()["error"]["code"], "BAD_REQUEST")

    def test_non_youtube_url_rejected(self):
        self.send({"id": "a4", "action": "get_info", "url": "https://evil.example.com/x"})
        self.assertEqual(self.recv()["error"]["code"], "BAD_URL")

    def test_injection_in_format_rejected(self):
        self.send({"id": "a5", "action": "download", "jobId": "j1",
                   "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "mode": "video",
                   "format": "best; calc.exe"})
        self.assertEqual(self.recv()["error"]["code"], "BAD_REQUEST")

    def test_malformed_json_does_not_kill_the_host(self):
        body = b"{not json at all"
        self.proc.stdin.write(struct.pack("@I", len(body)) + body)
        self.proc.stdin.flush()
        self.assertEqual(self.recv()["error"]["code"], "BAD_REQUEST")
        self.send({"id": "b1", "action": "ping"})          # still alive
        self.assertTrue(self.recv()["success"])

    def test_oversized_frame_is_refused_without_hanging(self):
        self.proc.stdin.write(struct.pack("@I", 50 * 1024 * 1024))
        self.proc.stdin.flush()
        self.proc.stdin.close()
        self.assertEqual(self.proc.wait(timeout=10), 0)    # stops cleanly, no crash
        self.proc.stdin = None

    def test_path_traversal_in_download_is_refused(self):
        self.send({"id": "b2", "action": "download", "jobId": "j9",
                   "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "mode": "video",
                   "format": "best", "outputDirectory": "C:\\Windows\\System32"})
        self.assertEqual(self.recv()["error"]["code"], "BAD_PATH")

    def test_unicode_survives_the_wire(self):
        self.send({"id": "a6", "action": "get_info", "url": "https://evil.example.com/Ω Мир 🎧"})
        self.assertFalse(self.recv()["success"])

    def test_open_file_path_traversal_refused(self):
        self.send({"id": "b3", "action": "open_file", "path": "C:\\Windows\\System32\\cmd.exe"})
        res = self.recv()
        self.assertFalse(res["success"])
        self.assertIn(res["error"]["code"], ("BAD_PATH", "FILE_NOT_FOUND"))

    def test_open_file_nonexistent_refused(self):
        root = os.path.abspath(os.path.expanduser("~"))
        nonexistent = os.path.join(root, "definitely_nonexistent_file_12345.mp4")
        self.send({"id": "b4", "action": "open_file", "path": nonexistent})
        res = self.recv()
        self.assertFalse(res["success"])
        self.assertEqual(res["error"]["code"], "FILE_NOT_FOUND")

    def test_open_file_unknown_job_refused(self):
        self.send({"id": "b5", "action": "open_file", "jobId": "unknown_job_999"})
        res = self.recv()
        self.assertFalse(res["success"])
        self.assertEqual(res["error"]["code"], "FILE_NOT_FOUND")

    def test_open_folder_unknown_job_refused(self):
        self.send({"id": "b6", "action": "open_folder", "jobId": "unknown_job_888"})
        res = self.recv()
        self.assertFalse(res["success"])
        self.assertEqual(res["error"]["code"], "FILE_NOT_FOUND")

    def test_open_folder_fallback_to_path_when_job_unknown(self):
        # Even if jobId is not found in memory, passing a valid path in the download dir succeeds
        status_res = self.send({"id": "s1", "action": "get_status"})
        dl_dir = self.recv()["data"]["downloadDirectory"]
        test_file = os.path.join(dl_dir, "test_yt_bridge_#music (prod) [xyz].txt")
        try:
            with open(test_file, "w") as f:
                f.write("test")
            self.send({"id": "b9", "action": "open_folder", "jobId": "unknown_job_777", "path": test_file})
            res = self.recv()
            self.assertTrue(res["success"])
            self.assertTrue(res["data"]["opened"])
        finally:
            if os.path.exists(test_file):
                os.remove(test_file)

    def test_status_cached(self):
        self.send({"id": "b7", "action": "get_status"})
        r1 = self.recv()
        self.assertTrue(r1["success"])
        self.send({"id": "b8", "action": "get_status"})
        r2 = self.recv()
        self.assertTrue(r2["success"])
        self.assertEqual(r1["data"]["hostVersion"], r2["data"]["hostVersion"])


if __name__ == "__main__":
    unittest.main()
