"""Download lifecycle against a stub that imitates yt-dlp's output."""
import os
import sys
import tempfile
import threading
import time
import unittest

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
sys.path.insert(0, SRC)

import ytdlp        # noqa: E402
from jobs import Jobs  # noqa: E402

OK_STUB = """
import sys, time
print("[youtube] Extracting URL: https://x")
for i in range(1, 4):
    print("@@PROG@@downloading|%d|300|NA|100|%d" % (i * 100, 3 - i), flush=True)
    time.sleep(0.05)
print("@@POST@@Merger|started")
print("@@FILE@@%s" % sys.argv[-1], flush=True)
"""
FAIL_STUB = "import sys; sys.stderr.write('ERROR: Video unavailable\\n'); sys.exit(1)"
HANG_STUB = """
import time
while True:
    print("@@PROG@@downloading|1|1000|NA|1|999", flush=True)
    time.sleep(0.1)
"""


class JobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.events = []
        self.lock = threading.Lock()
        self.jobs = Jobs(emit=lambda event: self.push(event))
        self.original = ytdlp.download_args

    def tearDown(self):
        ytdlp.download_args = self.original
        self.jobs.shutdown()

    def push(self, event):
        with self.lock:
            self.events.append(event)

    def stub(self, source):
        path = os.path.join(self.tmp, "stub.py")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(source)
        ytdlp.download_args = lambda spec, y, f: [sys.executable, path, os.path.join(self.tmp, "out.mp4")]

    def spec(self, job_id="j1", limit=2):
        return {"id": job_id, "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "mode": "video",
                "format": "best", "dir": self.tmp, "template": ytdlp.DEFAULT_TEMPLATE, "overwrite": "never",
                "audioFormat": "best", "audioQuality": "best", "container": "mp4",
                "maxConcurrent": limit, "ytdlp": "yt-dlp", "ffmpeg": ""}

    def wait(self, name, timeout=15):
        end = time.time() + timeout
        while time.time() < end:
            with self.lock:
                for event in self.events:
                    if event.get("event") == name:
                        return event
            time.sleep(0.05)
        self.fail(f"never saw {name}: {[e.get('event') for e in self.events]}")

    def test_progress_and_completion(self):
        self.stub(OK_STUB)
        self.jobs.start(self.spec())
        self.assertGreater(self.wait("progress")["percent"], 0)
        self.assertTrue(self.wait("stage")["stage"])
        self.assertTrue(self.wait("complete")["filepath"].endswith("out.mp4"))

    def test_failure_is_classified(self):
        self.stub(FAIL_STUB)
        self.jobs.start(self.spec("j2"))
        self.assertEqual(self.wait("error")["code"], "VIDEO_UNAVAILABLE")

    def test_cancel_only_touches_that_job(self):
        self.stub(HANG_STUB)
        self.jobs.start(self.spec("jA"))
        self.jobs.start(self.spec("jB"))
        self.wait("started")
        time.sleep(0.3)
        self.assertTrue(self.jobs.cancel("jA"))
        self.assertEqual(self.wait("cancelled")["id"], "jA")
        self.assertEqual(self.jobs.jobs["jA"]["state"], "cancelled")
        self.assertIn(self.jobs.jobs["jB"]["state"], ("queued", "downloading", "processing"))

    def test_queue_limit(self):
        self.stub(HANG_STUB)
        for index in range(4):
            self.jobs.start(self.spec(f"q{index}", limit=1))
        time.sleep(0.5)
        running = [j for j in self.jobs.jobs.values() if j["state"] == "downloading"]
        self.assertEqual(len(running), 1)

    def test_no_processes_survive_shutdown(self):
        self.stub(HANG_STUB)
        self.jobs.start(self.spec("jS"))
        self.wait("started")
        self.jobs.shutdown()
        time.sleep(1.0)
        self.assertTrue(all(job["process"] is None or job["process"].poll() is not None
                            for job in self.jobs.jobs.values()))


if __name__ == "__main__":
    unittest.main()
