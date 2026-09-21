import { strict as assert } from "node:assert";
import test from "node:test";
import { audioChoices, videoChoices } from "../formats";
import { DEFAULTS, bytes, clock, videoUrl, type RawFormat, type Settings } from "../shared";

const S: Settings = { ...DEFAULTS };

const RAW: RawFormat[] = [
  { format_id: "sb0", ext: "mhtml", vcodec: "none", acodec: "none", protocol: "mhtml" },
  { format_id: "hls", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 720, protocol: "m3u8_native" },
  { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 129, filesize: 3_000_000 },
  { format_id: "251", ext: "webm", vcodec: "none", acodec: "opus", abr: 160, filesize: 3_600_000 },
  { format_id: "18", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 360, fps: 30, filesize: 12_000_000 },
  { format_id: "136", ext: "mp4", vcodec: "avc1", acodec: "none", height: 720, fps: 30, filesize: 40_000_000 },
  { format_id: "299", ext: "mp4", vcodec: "avc1", acodec: "none", height: 1080, fps: 60, filesize: 120_000_000 },
  { format_id: "315", ext: "webm", vcodec: "vp9", acodec: "none", height: 2160, fps: 60, filesize: 900_000_000 },
  { format_id: "new", ext: "mp4", vcodec: "codec9", acodec: "none", height: 1080, unknown_field: 1 } as RawFormat,
];

test("storyboards and HLS never reach the user", () => {
  const labels = videoChoices(RAW, 600, S).map((c) => c.label);
  assert.deepEqual(labels, ["Best available", "2160p", "1080p", "720p", "360p"]);
});

test("video-only streams get merged with the best audio, with a fallback", () => {
  const p1080 = videoChoices(RAW, 600, S).find((c) => c.key === "p1080")!;
  assert.equal(p1080.selector, "299+140/bestvideo[height<=1080]+bestaudio/best[height<=1080]");
  assert.equal(p1080.needsFfmpeg, true);
  assert.match(p1080.note, /~117 MB|~1[12]\d MB/);
});

test("a stream that already has audio needs no ffmpeg", () => {
  const p360 = videoChoices(RAW, 600, S).find((c) => c.key === "p360")!;
  assert.equal(p360.needsFfmpeg, false);
  assert.equal(p360.selector, "18/bestvideo[height<=360]+bestaudio/best[height<=360]");
});

test("the quality setting caps what is offered", () => {
  const choices = videoChoices(RAW, 600, { ...S, videoQuality: "720" });
  assert.deepEqual(choices.map((c) => c.label), ["Best available", "720p", "360p"]);
  assert.ok(choices[0].selector.includes("[height<=720]"));
});

test("MP4 is preferred over WebM at the same resolution", () => {
  const raw: RawFormat[] = [
    { format_id: "a", ext: "webm", vcodec: "vp9", acodec: "none", height: 1080, tbr: 5000 },
    { format_id: "b", ext: "mp4", vcodec: "avc1", acodec: "none", height: 1080, tbr: 3000 },
    { format_id: "c", ext: "m4a", vcodec: "none", acodec: "mp4a", abr: 128 },
  ];
  assert.match(videoChoices(raw, 100, S).find((c) => c.key === "p1080")!.selector, /^b\+c\//);
});

test("audio list is exactly Best, M4A, MP3, Opus and only MP3 converts", () => {
  const choices = audioChoices(RAW, 600, S);
  assert.deepEqual(choices.map((c) => c.label), ["Best available", "M4A", "MP3", "Opus"]);
  assert.deepEqual(choices.map((c) => c.needsFfmpeg), [false, false, true, false]);
  assert.match(choices[2].note, /converted from the 160 kbps source/);
});

test("no formats means no choices, not a crash", () => {
  assert.deepEqual(videoChoices([], null, S), []);
  assert.deepEqual(audioChoices(undefined, null, S), []);
});

test("labels stay user-friendly and every selector has a fallback", () => {
  for (const choice of [...videoChoices(RAW, 600, S), ...audioChoices(RAW, 600, S)]) {
    assert.doesNotMatch(choice.label, /\+|avc1|vp9|opus\d|\b\d{3}\b/);   // no format IDs or codecs
    assert.ok(choice.selector.includes("/"), `${choice.key} has no fallback`);
  }
});

test("a resolution the video does not have is never offered", () => {
  const raw: RawFormat[] = [
    { format_id: "v", ext: "mp4", vcodec: "avc1", acodec: "none", height: 720, tbr: 1000 },
    { format_id: "a", ext: "m4a", vcodec: "none", acodec: "mp4a", abr: 128 },
  ];
  assert.deepEqual(videoChoices(raw, 60, S).map((c) => c.label), ["Best available", "720p"]);
});

test("URL parsing keeps the video and drops the playlist", () => {
  assert.equal(videoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1")!.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(videoUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")!.shorts, true);
  assert.equal(videoUrl("https://youtu.be/dQw4w9WgXcQ")!.id, "dQw4w9WgXcQ");
  assert.equal(videoUrl("https://www.youtube.com/live/dQw4w9WgXcQ")!.id, "dQw4w9WgXcQ");
  assert.equal(videoUrl("https://www.youtube.com/feed/subscriptions"), null);
  assert.equal(videoUrl("https://evil.example.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(videoUrl("javascript:alert(1)"), null);
});

test("byte and clock formatting", () => {
  assert.equal(bytes(0), "");
  assert.equal(bytes(650_000_000, true), "~620 MB");
  assert.equal(clock(763), "12:43");
  assert.equal(clock(3671), "1:01:11");
});
