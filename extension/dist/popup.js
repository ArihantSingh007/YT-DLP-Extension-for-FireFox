"use strict";
(() => {
  // src/shared.ts
  var ext = globalThis.browser ?? globalThis.chrome;
  async function send(message) {
    try {
      return await ext.runtime.sendMessage(message);
    } catch (cause) {
      return { ok: false, error: { code: "EXTENSION_ERROR", message: "The extension is not responding.", detail: String(cause?.message ?? cause) } };
    }
  }
  function bytes(value, approx = false) {
    if (!value || !isFinite(value) || value <= 0) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let n = value;
    let u = 0;
    while (n >= 1024 && u < units.length - 1) {
      n /= 1024;
      u += 1;
    }
    return `${approx ? "~" : ""}${n.toFixed(n >= 100 || u === 0 ? 0 : 1)} ${units[u]}`;
  }
  function clock(seconds) {
    if (seconds == null || !isFinite(seconds) || seconds < 0) return "";
    const t = Math.round(seconds);
    const h = Math.floor(t / 3600);
    const m = Math.floor(t % 3600 / 60);
    const s = String(t % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // src/popup.ts
  var list = document.getElementById("jobs");
  function line(job) {
    if (job.state === "queued") return "Queued";
    if (job.state === "downloading") {
      return [
        `${(job.percent ?? 0).toFixed(0)}%`,
        job.totalBytes ? `${bytes(job.downloadedBytes)} / ${bytes(job.totalBytes)}` : "",
        job.speed ? `${bytes(job.speed)}/s` : "",
        job.eta ? `${clock(job.eta)} left` : ""
      ].filter(Boolean).join(" \u2022 ");
    }
    if (job.state === "processing") return job.stage ?? "Processing";
    if (job.state === "failed") return job.error?.message ?? "Failed";
    return job.state === "completed" ? "Completed" : "Cancelled";
  }
  function render(jobs) {
    if (!jobs.length) {
      list.innerHTML = `<p class="muted">Nothing downloading.</p>`;
      return;
    }
    list.innerHTML = "";
    for (const job of jobs) {
      const active = job.state === "queued" || job.state === "downloading" || job.state === "processing";
      const row = document.createElement("div");
      row.className = "j";
      row.innerHTML = `<div class="top"><span class="name">${escapeHtml(job.title || "Download")}</span>
      <span class="muted">${escapeHtml(job.label)}</span></div>
      ${active ? `<div class="bar"><i style="width:${Math.min(100, job.percent ?? 0)}%"></i></div>` : ""}
      <div class="top"><span class="muted">${escapeHtml(line(job))}</span><span class="act"></span></div>`;
      const act = row.querySelector(".act");
      if (active) act.append(make("Cancel", () => void send({ type: "cancel", jobId: job.id })));
      else if (job.state === "completed" && job.filepath) act.append(make("Folder", () => void send({ type: "openFolder", path: job.filepath })));
      if (!active) act.append(make("Remove", async () => {
        await send({ type: "forget", jobId: job.id });
        void refresh();
      }));
      list.append(row);
    }
  }
  function make(label, onClick) {
    const button = document.createElement("button");
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }
  async function refresh() {
    const reply = await send({ type: "jobs" });
    render(reply.ok ? reply.data : []);
  }
  ext.runtime.onMessage.addListener((message) => {
    if (message?.type === "job") void refresh();
    return void 0;
  });
  document.getElementById("settings").addEventListener("click", () => {
    ext.runtime.openOptionsPage();
    window.close();
  });
  void refresh();
})();
