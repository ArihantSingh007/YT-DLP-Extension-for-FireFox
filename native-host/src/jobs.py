"""Download jobs: one yt-dlp process per job, a queue, cancellation.

Nothing here runs unless a download exists; there is no timer and no worker
pool sitting idle."""
from __future__ import annotations

import os
import subprocess
import threading
import time
from collections import deque

import ytdlp

PROGRESS_EVERY = 0.25


class Jobs:
    def __init__(self, emit):
        self.emit = emit
        self.lock = threading.RLock()
        self.jobs = {}          # id -> dict(state, process, cancelled, files)
        self.queue = deque()
        self.active = 0
        self.limit = 2

    # ------------------------------------------------------------------ api

    def start(self, spec: dict) -> dict:
        with self.lock:
            if spec["id"] in self.jobs:
                raise ValueError("duplicate job id")
            self.limit = max(1, min(8, int(spec.get("maxConcurrent", 2))))
            self.jobs[spec["id"]] = {"spec": spec, "state": "queued", "process": None,
                                     "cancelled": False, "files": [], "errors": deque(maxlen=40),
                                     "started": False, "settled": False}
            self.queue.append(spec["id"])
        self._send(spec["id"], "queued")
        self._pump()
        return {"id": spec["id"], "state": "queued"}

    def cancel(self, job_id: str) -> bool:
        with self.lock:
            job = self.jobs.get(job_id)
            if not job or job["state"] in ("completed", "failed", "cancelled"):
                return False
            job["cancelled"] = True
            if job["state"] == "queued":
                try:
                    self.queue.remove(job_id)
                except ValueError:
                    pass
                job["state"] = "cancelled"
                self._send(job_id, "cancelled")
                return True
            process = job["process"]
        if process and process.poll() is None:
            self._kill(process)
        return True

    def shutdown(self) -> None:
        with self.lock:
            self.queue.clear()
            running = [job for job in self.jobs.values() if job["process"]]
        for job in running:
            job["cancelled"] = True
            self._kill(job["process"])

    # ------------------------------------------------------------ internals

    def _pump(self) -> None:
        with self.lock:
            while self.queue and self.active < self.limit:
                job_id = self.queue.popleft()
                job = self.jobs.get(job_id)
                if not job or job["cancelled"]:
                    continue
                self.active += 1
                job["started"] = True
                threading.Thread(target=self._run, args=(job_id,), name=f"job-{job_id}", daemon=True).start()

    def _kill(self, process) -> None:
        """Kill this process tree only."""
        try:
            if ytdlp.IS_WINDOWS:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], timeout=15,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=ytdlp.NO_WINDOW)
            else:
                os.killpg(os.getpgid(process.pid), 15)
                time.sleep(1.0)
                if process.poll() is None:
                    os.killpg(os.getpgid(process.pid), 9)
        except Exception:
            try:
                process.kill()
            except OSError:
                pass

    def _run(self, job_id: str) -> None:
        job = self.jobs[job_id]
        spec = job["spec"]
        args = ytdlp.download_args(spec, spec["ytdlp"], spec["ffmpeg"])
        kwargs = {"stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE, "stderr": subprocess.PIPE,
                  "cwd": spec["dir"], "creationflags": ytdlp.NO_WINDOW}
        if not ytdlp.IS_WINDOWS:
            kwargs["start_new_session"] = True
        try:
            process = subprocess.Popen(args, **kwargs)
        except OSError as cause:
            return self._finish(job_id, "failed", code="FAILED", message="yt-dlp could not be started.", detail=str(cause))

        with self.lock:
            job["process"] = process
            job["state"] = "downloading"
        self._send(job_id, "started")

        errors = threading.Thread(target=self._drain, args=(job, process), daemon=True)
        errors.start()

        last = 0.0
        for raw in process.stdout:
            event = ytdlp.parse_line(raw.decode("utf-8", "replace").rstrip("\r\n"))
            if not event:
                continue
            if event["kind"] == "progress":
                now = time.time()
                if now - last >= PROGRESS_EVERY or event["status"] == "finished":
                    last = now
                    self._send(job_id, "progress", **{k: v for k, v in event.items() if k != "kind"})
            elif event["kind"] == "stage":
                job["state"] = "processing"
                self._send(job_id, "stage", stage=event["stage"])
            elif event["kind"] == "file":
                job["files"].append(event["filepath"])

        code = process.wait()
        errors.join(timeout=5)
        for stream in (process.stdout, process.stderr):
            try:
                stream.close()
            except OSError:
                pass

        if job["cancelled"]:
            self._cleanup(job)
            return self._finish(job_id, "cancelled")
        if code == 0:
            path = job["files"][-1] if job["files"] else None
            if path and not os.path.isabs(path):
                path = os.path.join(spec["dir"], path)
            return self._finish(job_id, "completed", filepath=path)
        stderr = "\n".join(job["errors"])
        error_code, message = ytdlp.classify(stderr, code)
        self._finish(job_id, "failed", code=error_code, message=message, detail=stderr[-1200:])

    def _drain(self, job, process) -> None:
        for raw in process.stderr:
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                job["errors"].append(line)

    def _cleanup(self, job) -> None:
        for path in job["files"]:
            base = path if os.path.isabs(path) else os.path.join(job["spec"]["dir"], path)
            for partial in (base + ".part", base + ".ytdl"):
                try:
                    if os.path.isfile(partial):
                        os.remove(partial)
                except OSError:
                    pass

    def _finish(self, job_id: str, state: str, **fields) -> None:
        with self.lock:
            job = self.jobs[job_id]
            job["state"] = state
            job["process"] = None
            if job["started"] and not job["settled"]:
                job["settled"] = True
                self.active = max(0, self.active - 1)
        name = {"completed": "complete", "cancelled": "cancelled"}.get(state, "error")
        self._send(job_id, name, **fields)
        self._pump()

    def _send(self, job_id: str, event: str, **fields) -> None:
        payload = {"id": job_id, "event": event, "state": self.jobs[job_id]["state"]}
        payload.update({k: v for k, v in fields.items() if v is not None})
        self.emit(payload)
