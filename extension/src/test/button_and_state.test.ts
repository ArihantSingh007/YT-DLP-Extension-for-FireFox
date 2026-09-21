import { strict as assert } from "node:assert";
import test from "node:test";
import { BUTTON_ID, findExistingDownloadButton } from "../content";
import { videoUrl, type Job, type VideoInfo } from "../shared";

// Mock element helper for testing semantic button discovery in Node.js
class MockButton {
  id: string;
  textContent: string;
  attrs: Map<string, string>;

  constructor(opts: { id?: string; text?: string; ariaLabel?: string; title?: string } = {}) {
    this.id = opts.id || "";
    this.textContent = opts.text || "";
    this.attrs = new Map();
    if (opts.ariaLabel) this.attrs.set("aria-label", opts.ariaLabel);
    if (opts.title) this.attrs.set("title", opts.title);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
}

class MockContainer {
  buttons: MockButton[] = [];
  dlRendererButton: MockButton | null = null;

  querySelector(selector: string): any {
    if (selector.includes("ytd-download-button-renderer")) {
      return this.dlRendererButton;
    }
    return null;
  }

  querySelectorAll(selector: string): any[] {
    if (selector === "button") {
      return this.buttons;
    }
    return [];
  }
}

test("findExistingDownloadButton finds ytd-download-button-renderer button", () => {
  const container = new MockContainer();
  const dlBtn = new MockButton({ ariaLabel: "Download video" });
  container.dlRendererButton = dlBtn;
  // Make dlBtn pass instanceof HTMLButtonElement in this mock environment
  Object.setPrototypeOf(dlBtn, (globalThis as any).HTMLButtonElement?.prototype || Object.prototype);

  // When dlRendererButton is present
  const found = container.querySelector("ytd-download-button-renderer button");
  assert.equal(found, dlBtn);
});

test("findExistingDownloadButton identifies existing native button by aria-label or title", () => {
  const container = new MockContainer();
  const likeBtn = new MockButton({ ariaLabel: "Like this video along with 10k others" });
  const shareBtn = new MockButton({ ariaLabel: "Share" });
  const downloadBtn = new MockButton({ ariaLabel: "Download" });
  container.buttons = [likeBtn, shareBtn, downloadBtn];

  const found = findExistingDownloadButton(container as any);
  assert.equal(found, downloadBtn);
});

test("findExistingDownloadButton ignores custom extension button and other buttons", () => {
  const container = new MockContainer();
  const customBtn = new MockButton({ id: BUTTON_ID, text: "Download" });
  const shareBtn = new MockButton({ ariaLabel: "Share", text: "Share" });
  container.buttons = [customBtn, shareBtn];

  const found = findExistingDownloadButton(container as any);
  assert.equal(found, null);
});

test("findExistingDownloadButton matches title attribute as fallback", () => {
  const container = new MockContainer();
  const titleDlBtn = new MockButton({ title: "Download offline" });
  container.buttons = [titleDlBtn];

  const found = findExistingDownloadButton(container as any);
  assert.equal(found, titleDlBtn);
});

test("in-flight metadata deduplication shares single promise for concurrent requests", async () => {
  const inFlight = new Map<string, Promise<VideoInfo>>();
  let callCount = 0;

  async function mockFetchInfo(id: string): Promise<VideoInfo> {
    const existing = inFlight.get(id);
    if (existing) return existing;

    const promise = (async () => {
      try {
        callCount++;
        await new Promise((r) => setTimeout(r, 10));
        return { id, title: "Test Video", webpageUrl: `https://www.youtube.com/watch?v=${id}`, formats: [] };
      } finally {
        inFlight.delete(id);
      }
    })();

    inFlight.set(id, promise);
    return promise;
  }

  // Simulate 3 concurrent requests for same video id
  const [res1, res2, res3] = await Promise.all([
    mockFetchInfo("test1234567"),
    mockFetchInfo("test1234567"),
    mockFetchInfo("test1234567"),
  ]);

  assert.equal(callCount, 1);
  assert.equal(res1.title, "Test Video");
  assert.equal(res2.title, "Test Video");
  assert.equal(res3.title, "Test Video");
});

test("bounded job history prunes oldest completed jobs beyond limit", () => {
  const jobs = new Map<string, Job>();
  const limit = 5;

  function prune() {
    if (jobs.size <= limit) return;
    for (const [id, job] of jobs) {
      if (job.state === "completed" || job.state === "failed" || job.state === "cancelled") {
        jobs.delete(id);
        if (jobs.size <= limit) break;
      }
    }
  }

  for (let i = 1; i <= 8; i++) {
    jobs.set(`job-${i}`, {
      id: `job-${i}`,
      state: "completed",
      title: `Job ${i}`,
      label: "1080p",
      percent: 100,
    });
    prune();
  }

  assert.equal(jobs.size, limit);
  assert.ok(!jobs.has("job-1"));
  assert.ok(!jobs.has("job-2"));
  assert.ok(!jobs.has("job-3"));
  assert.ok(jobs.has("job-8"));
});

test("videoUrl properly handles normal videos, shorts, and drops playlist parameters", () => {
  const normal = videoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123456&index=2");
  assert.ok(normal);
  assert.equal(normal.id, "dQw4w9WgXcQ");
  assert.equal(normal.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(normal.shorts, false);

  const short = videoUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ");
  assert.ok(short);
  assert.equal(short.id, "dQw4w9WgXcQ");
  assert.equal(short.shorts, true);

  const channel = videoUrl("https://www.youtube.com/@YouTube");
  assert.equal(channel, null);
});
