import { bytes, clock, escapeHtml, ext, send, type Job } from "./shared";

const list = document.getElementById("jobs")!;

function line(job: Job): string {
  if (job.state === "queued") return "Queued";
  if (job.state === "downloading") {
    return [`${(job.percent ?? 0).toFixed(0)}%`,
      job.totalBytes ? `${bytes(job.downloadedBytes)} / ${bytes(job.totalBytes)}` : "",
      job.speed ? `${bytes(job.speed)}/s` : "",
      job.eta ? `${clock(job.eta)} left` : ""].filter(Boolean).join(" • ");
  }
  if (job.state === "processing") return job.stage ?? "Processing";
  if (job.state === "failed") return job.error?.message ?? "Failed";
  return job.state === "completed" ? "Completed" : "Cancelled";
}

function render(jobs: Job[]): void {
  if (!jobs.length) { list.innerHTML = `<p class="muted">Nothing downloading.</p>`; return; }
  list.innerHTML = "";
  for (const job of jobs) {
    const active = job.state === "queued" || job.state === "downloading" || job.state === "processing";
    const row = document.createElement("div");
    row.className = "j";
    row.innerHTML = `<div class="top"><span class="name">${escapeHtml(job.title || "Download")}</span>
      <span class="muted">${escapeHtml(job.label)}</span></div>
      ${active ? `<div class="bar"><i style="width:${Math.min(100, job.percent ?? 0)}%"></i></div>` : ""}
      <div class="top"><span class="muted">${escapeHtml(line(job))}</span><span class="act"></span></div>`;
    const act = row.querySelector(".act")!;
    if (active) act.append(make("Cancel", () => void send({ type: "cancel", jobId: job.id })));
    else if (job.state === "completed" && job.filepath) act.append(make("Folder", () => void send({ type: "openFolder", path: job.filepath! })));
    if (!active) act.append(make("Remove", async () => { await send({ type: "forget", jobId: job.id }); void refresh(); }));
    list.append(row);
  }
}

function make(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

async function refresh(): Promise<void> {
  const reply = await send<Job[]>({ type: "jobs" });
  render(reply.ok ? reply.data : []);
}

// Event-driven: the background page pushes an update whenever a job changes.
ext.runtime.onMessage.addListener((message: any) => {
  if (message?.type === "job") void refresh();
  return undefined;
});
document.getElementById("settings")!.addEventListener("click", () => { ext.runtime.openOptionsPage(); window.close(); });
void refresh();
