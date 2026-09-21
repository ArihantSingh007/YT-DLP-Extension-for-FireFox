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
    if (job.state === "failed") return job.error?.message ?? "Download failed";
    return job.state === "completed" ? "Completed" : "Cancelled";
  }
  function renderEmpty(container) {
    container.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "10");
    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.setAttribute("points", "8 12 12 16 16 12");
    const lineEl = document.createElementNS("http://www.w3.org/2000/svg", "line");
    lineEl.setAttribute("x1", "12");
    lineEl.setAttribute("y1", "8");
    lineEl.setAttribute("x2", "12");
    lineEl.setAttribute("y2", "16");
    svg.append(circle, polyline, lineEl);
    const p1 = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = "No downloads yet";
    p1.append(strong);
    const p2 = document.createElement("p");
    p2.className = "sub";
    p2.textContent = "Click Download on YouTube to start saving videos";
    empty.append(svg, p1, p2);
    container.append(empty);
  }
  function render(jobs) {
    if (!jobs.length) {
      renderEmpty(list);
      return;
    }
    list.replaceChildren();
    for (const job of jobs) {
      const active = job.state === "queued" || job.state === "downloading" || job.state === "processing";
      const percent = Math.max(0, Math.min(100, job.percent ?? 0));
      const card = document.createElement("div");
      card.className = "job-card";
      const header = document.createElement("div");
      header.className = "job-header";
      const titleSpan = document.createElement("span");
      titleSpan.className = "job-title";
      const titleText = job.title || "Download";
      titleSpan.title = titleText;
      titleSpan.textContent = titleText;
      const badge = document.createElement("span");
      badge.className = "job-badge";
      badge.textContent = job.label || "Best";
      header.append(titleSpan, badge);
      card.append(header);
      if (active) {
        const barWrap = document.createElement("div");
        barWrap.className = "job-progress-bar";
        const bar = document.createElement("i");
        bar.style.width = `${percent}%`;
        barWrap.append(bar);
        card.append(barWrap);
      }
      const footer = document.createElement("div");
      footer.className = "job-footer";
      const meta = document.createElement("span");
      meta.className = "job-meta";
      const metaText = line(job);
      meta.title = metaText;
      meta.textContent = metaText;
      const actions = document.createElement("div");
      actions.className = "job-actions";
      if (active) {
        actions.append(makeBtn("Cancel", "job-btn danger", () => void send({ type: "cancel", jobId: job.id })));
      } else if (job.state === "completed") {
        actions.append(makeBtn("Open", "job-btn primary", () => void send({ type: "openFile", jobId: job.id, path: job.filepath ?? "" })));
        actions.append(makeBtn("Location", "job-btn", () => void send({ type: "openFolder", jobId: job.id, path: job.filepath ?? "" })));
      }
      if (!active) {
        actions.append(makeBtn("Remove", "job-btn ghost", async () => {
          await send({ type: "forget", jobId: job.id });
          void refresh();
        }));
      }
      footer.append(meta, actions);
      card.append(footer);
      list.append(card);
    }
  }
  function makeBtn(label, className, onClick) {
    const button = document.createElement("button");
    button.className = className;
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
