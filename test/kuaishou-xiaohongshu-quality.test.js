import assert from "node:assert/strict";
import test from "node:test";

import { PlatformError, preferPlatformError } from "../scripts/platforms/base.js";
import { KuaishouParser } from "../scripts/platforms/kuaishou.js";
import { XiaohongshuParser, classifyXiaohongshuFeedApiError } from "../scripts/platforms/xiaohongshu.js";

function pageWithInitialState(initialState) {
  return {
    async evaluate(callback, argument) {
      const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
      const previousWindow = globalThis.window;
      globalThis.window = { __INITIAL_STATE__: initialState };
      try {
        return callback(argument);
      } finally {
        if (hadWindow) globalThis.window = previousWindow;
        else delete globalThis.window;
      }
    },
  };
}

test("Kuaishou selects a higher-resolution HEVC manifest over a lower-resolution H264 URL", () => {
  const parser = new KuaishouParser();
  const candidates = parser._collectDetailMediaCandidates({
    photoUrl: "https://media.kwaicdn.com/low.mp4",
    manifestH265: {
      json: {
        adaptationSet: [{
          representation: [{
            url: "https://media.kwaicdn.com/high.mp4",
            width: 1920,
            height: 1080,
            frameRate: 60,
            avgBitrate: 8_000_000,
            fileSize: 80_000_000,
          }],
        }],
      },
    },
  });

  const streams = parser._normalizeAvailableStreams(candidates, "https://www.kuaishou.com/short-video/id");
  assert.equal(streams[0].url, "https://media.kwaicdn.com/high.mp4");
  assert.equal(streams[0].codec, "hevc");
  assert.equal(streams[0].fps, 60);
  assert.equal(streams[0].label, "1920x1080@60");
});

test("Kuaishou uses codec compatibility only when quality fields tie", () => {
  const parser = new KuaishouParser();
  const candidates = [
    { url: "https://media.kwaicdn.com/hevc.mp4", width: 1920, height: 1080, fps: 30, bitrate: 5_000_000, totalBytes: 50, codec: "hevc" },
    { url: "https://media.kwaicdn.com/h264.mp4", width: 1920, height: 1080, fps: 30, bitrate: 5_000_000, totalBytes: 50, codec: "h264" },
  ];
  assert.equal(parser._normalizeAvailableStreams(candidates, "https://www.kuaishou.com/")[0].codec, "h264");
});

test("Xiaohongshu selects higher-resolution H265 instead of lower-resolution H264", () => {
  const parser = new XiaohongshuParser();
  const note = {
    video: {
      media: {
        stream: {
          h264: [{ masterUrl: "https://sns-video.xhscdn.com/low.mp4", width: 720, height: 1280, fps: 30, avgBitrate: 2_000_000, size: 20_000_000 }],
          h265: [{ masterUrl: "https://sns-video.xhscdn.com/high.mp4", width: 1080, height: 1920, fps: 30, avgBitrate: 4_000_000, size: 40_000_000 }],
        },
      },
    },
  };

  const candidates = parser._collectNoteMediaCandidates(note);
  const streams = parser._normalizeAvailableStreams(candidates, "https://www.xiaohongshu.com/");
  assert.equal(streams[0].url, "https://sns-video.xhscdn.com/high.mp4");
  assert.equal(streams[0].codec, "h265");
  assert.deepEqual(
    Object.keys(streams[0]),
    ["url", "type", "format", "width", "height", "fps", "bitrate", "codec", "quality", "label", "source", "totalBytes", "referer"],
  );
});

test("Xiaohongshu parses mediaV2 JSON and prefers its HD screencast stream", () => {
  const parser = new XiaohongshuParser();
  const note = {
    video: {
      media: {
        stream: {
          h264: [{
            masterUrl: "https://sns-video.xhscdn.com/public-720.mp4",
            width: 1280,
            height: 720,
            fps: 30,
            avgBitrate: 2_000_000,
          }],
        },
      },
      mediaV2: JSON.stringify({
        stream: {
          h264: [{
            master_url: "https://sns-video.xhscdn.com/media-v2-720.mp4",
            width: 1280,
            height: 720,
            fps: 30,
            avg_bitrate: 2_100_000,
            video_codec: "h264",
          }],
        },
        video: {
          width: 1920,
          height: 1080,
          opaque1: {
            hd_screencast_stream: "https://sns-video.xhscdn.com/hidden-1080.mp4",
            default_screencast_stream: "https://sns-video.xhscdn.com/default-720.mp4",
          },
        },
      }),
    },
  };

  const streams = parser._normalizeAvailableStreams(
    parser._collectNoteMediaCandidates(note),
    "https://www.xiaohongshu.com/",
  );

  assert.equal(streams[0].url, "https://sns-video.xhscdn.com/hidden-1080.mp4");
  assert.equal(streams[0].width, 1920);
  assert.equal(streams[0].height, 1080);
  assert.equal(streams[0].source, "media-v2-hd-screencast");
  assert.ok(streams.some((stream) => stream.url.endsWith("media-v2-720.mp4")));
  const defaultStream = streams.find((stream) => stream.source === "media-v2-default-screencast");
  assert.equal(defaultStream.width, null);
  assert.equal(defaultStream.height, null);
});

test("Xiaohongshu accepts JSON-encoded opaque screencast metadata", () => {
  const parser = new XiaohongshuParser();
  const note = {
    video: {
      mediaV2: JSON.stringify({
        video: {
          width: 1920,
          height: 1080,
          opaque1: JSON.stringify({
            hd_screencast_stream: JSON.stringify({
              master_url: "https://sns-video.xhscdn.com/encoded-hidden-1080.mp4",
              video_codec: "h265",
            }),
          }),
        },
      }),
    },
  };

  const streams = parser._normalizeAvailableStreams(
    parser._collectNoteMediaCandidates(note),
    "https://www.xiaohongshu.com/",
  );

  assert.equal(streams[0].url, "https://sns-video.xhscdn.com/encoded-hidden-1080.mp4");
  assert.equal(streams[0].codec, "h265");
});

test("Xiaohongshu ignores malformed mediaV2 and keeps legacy streams", () => {
  const parser = new XiaohongshuParser();
  const note = {
    video: {
      mediaV2: "{broken",
      media: {
        stream: {
          h264: [{ masterUrl: "https://sns-video.xhscdn.com/legacy.mp4", width: 1280, height: 720 }],
        },
      },
    },
  };

  const candidates = parser._collectNoteMediaCandidates(note);
  assert.equal(candidates[0].url, "https://sns-video.xhscdn.com/legacy.mp4");
});

test("Xiaohongshu treats the short edge as the quality tier and prioritizes 1080p over frame rate", () => {
  const parser = new XiaohongshuParser();
  const streams = parser._normalizeAvailableStreams([
    { url: "https://sns-video.xhscdn.com/4k.mp4", width: 3840, height: 2160, fps: 25 },
    { url: "https://sns-video.xhscdn.com/1080-25.mp4", width: 1920, height: 1080, fps: 25 },
    { url: "https://sns-video.xhscdn.com/720-60.mp4", width: 1280, height: 720, fps: 60 },
  ], "https://www.xiaohongshu.com/");

  const limited = parser._limitStreamsByQuality(streams, 1080);
  assert.deepEqual(limited.map((stream) => stream.url), [
    "https://sns-video.xhscdn.com/1080-25.mp4",
    "https://sns-video.xhscdn.com/720-60.mp4",
  ]);
});

test("Xiaohongshu refuses to download above the requested quality tier", () => {
  const parser = new XiaohongshuParser();
  const streams = parser._normalizeAvailableStreams([
    { url: "https://sns-video.xhscdn.com/4k.mp4", width: 3840, height: 2160, fps: 25 },
  ], "https://www.xiaohongshu.com/");

  assert.throws(
    () => parser._limitStreamsByQuality(streams, 1080),
    (error) => error.code === "QUALITY_LIMIT_UNAVAILABLE",
  );
});

test("Xiaohongshu binds API and page state to the exact target note ID", async () => {
  const parser = new XiaohongshuParser();
  const targetNote = { noteId: "target-note", title: "target" };
  const unrelatedNote = { noteId: "other-note", title: "other" };
  const feedPayloads = [
    { items: [{ note_card: unrelatedNote }] },
    { items: [{ note_card: targetNote }] },
  ];

  assert.equal(parser._extractNoteFromApi(feedPayloads, [unrelatedNote], "target-note"), targetNote);

  const page = pageWithInitialState({
    note: {
      noteDetailMap: {
        "other-note": { note: unrelatedNote },
        "target-note": { note: targetNote },
      },
    },
  });
  assert.deepEqual(await parser._extractNoteFromPage(page, "target-note"), targetNote);
  assert.equal(await parser._hasPageNoteState(page, "target-note"), true);

  const standalonePage = pageWithInitialState({
    note: {
      noteDetailMap: {
        "other-note": { note: unrelatedNote },
      },
      note: targetNote,
    },
  });
  assert.deepEqual(await parser._extractNoteFromPage(standalonePage, "target-note"), targetNote);
});

test("Xiaohongshu parses SSR initial state from a mobile share response", () => {
  const parser = new XiaohongshuParser();
  const mediaV2 = JSON.stringify({
    video: {
      width: 1920,
      height: 1080,
      opaque1: { hd_screencast_stream: "https://sns-video.xhscdn.com/ssr-1080.mp4" },
    },
  });
  const state = {
    note: {
      noteDetailMap: {
        "mobile-note": {
          note: { noteId: "mobile-note", type: "video", video: { mediaV2 }, optional: null },
        },
      },
    },
  };
  const serialized = JSON.stringify(state).replace('"optional":null', '"optional":undefined');
  const html = `<script>window.__INITIAL_STATE__=${serialized}</script>`;

  const parsedState = parser._extractInitialStateFromHtml(html);
  const note = parser._extractNoteFromState(parsedState, "mobile-note");
  const streams = parser._normalizeAvailableStreams(
    parser._collectNoteMediaCandidates(note),
    "https://www.xiaohongshu.com/",
  );

  assert.equal(streams[0].url, "https://sns-video.xhscdn.com/ssr-1080.mp4");
  assert.equal(streams[0].source, "media-v2-hd-screencast");
});

test("Xiaohongshu does not fall back to unrelated notes or media for a known target", async () => {
  const parser = new XiaohongshuParser();
  const unrelatedNote = { noteId: "other-note", title: "other" };
  const feedPayloads = [{ items: [{ note_card: unrelatedNote }] }];
  const page = pageWithInitialState({
    note: {
      noteDetailMap: {
        "other-note": { note: unrelatedNote },
        "wrong-map-key": { note: { noteId: "target-note", title: "mis-keyed target" } },
      },
      note: unrelatedNote,
    },
  });
  const runtimeMedia = [{ url: "https://sns-video.xhscdn.com/unrelated.mp4" }];

  assert.equal(parser._extractNoteFromApi(feedPayloads, [unrelatedNote], "target-note"), null);
  assert.equal(await parser._extractNoteFromPage(page, "target-note"), null);
  assert.equal(
    await parser._shouldStopWaitingForNote(
      page,
      feedPayloads,
      [unrelatedNote],
      "target-note",
      runtimeMedia,
    ),
    false,
  );

  const targetVideoWithoutMedia = { noteId: "target-note", type: "video" };
  assert.equal(
    await parser._shouldStopWaitingForNote(
      page,
      [{ items: [{ note_card: targetVideoWithoutMedia }] }],
      [],
      "target-note",
      [],
    ),
    false,
  );
  assert.equal(
    await parser._shouldStopWaitingForNote(
      page,
      [{ items: [{ note_card: targetVideoWithoutMedia }] }],
      [],
      "target-note",
      runtimeMedia,
    ),
    true,
  );
});

test("Xiaohongshu prefers target-note media and uses runtime media only when it has none", () => {
  const parser = new XiaohongshuParser();
  const targetNote = {
    noteId: "target-note",
    video: {
      media: {
        stream: {
          h264: [{
            masterUrl: "https://sns-video.xhscdn.com/target-720.mp4",
            width: 720,
            height: 1280,
          }],
        },
      },
    },
  };
  const runtimeMedia = [{
    url: "https://sns-video.xhscdn.com/unrelated-4k.mp4",
    width: 2160,
    height: 3840,
    source: "media-response",
  }];

  const targetStreams = parser._resolveAvailableStreams(
    targetNote,
    runtimeMedia,
    "https://www.xiaohongshu.com/",
  );
  assert.deepEqual(targetStreams.map((stream) => stream.url), [
    "https://sns-video.xhscdn.com/target-720.mp4",
  ]);

  const runtimeFallback = parser._resolveAvailableStreams(
    { noteId: "target-note", type: "video" },
    runtimeMedia,
    "https://www.xiaohongshu.com/",
  );
  assert.equal(runtimeFallback[0].url, "https://sns-video.xhscdn.com/unrelated-4k.mp4");

  const imageNoteStreams = parser._resolveAvailableStreams(
    { noteId: "image-note", type: "normal", imageList: [{ url: "https://sns-img.xhscdn.com/a.jpg" }] },
    runtimeMedia,
    "https://www.xiaohongshu.com/",
  );
  assert.deepEqual(imageNoteStreams, []);
});

test("Xiaohongshu excludes HLS manifests and segments while keeping direct MP4 candidates", () => {
  const parser = new XiaohongshuParser();
  const hlsUrl = "https://sns-video.xhscdn.com/master.m3u8?token=test";
  const queryHlsUrl = "https://sns-video.xhscdn.com/master?format=m3u8";
  const pathHlsUrl = "https://sns-video.xhscdn.com/hls/master";
  const hlsSegmentUrl = "https://sns-video.xhscdn.com/segments/segment-001.ts?token=test";
  const mp4Url = "https://sns-video.xhscdn.com/direct.mp4?token=test";
  const noteCandidates = parser._collectNoteMediaCandidates({
    video: {
      media: {
        stream: {
          h264: [
            {
              masterUrl: hlsUrl,
              url: mp4Url,
              width: 720,
              height: 1280,
            },
          ],
        },
      },
    },
  });
  const runtimeStreams = parser._normalizeAvailableStreams([
    { url: hlsUrl, width: 2160, height: 3840 },
    { url: queryHlsUrl, width: 2160, height: 3840 },
    { url: pathHlsUrl, width: 2160, height: 3840 },
    { url: hlsSegmentUrl, width: 2160, height: 3840 },
    { url: mp4Url, width: 720, height: 1280 },
  ], "https://www.xiaohongshu.com/");

  assert.equal(parser._isVideoCdnUrl(hlsUrl), false);
  assert.equal(parser._isVideoCdnUrl(queryHlsUrl), false);
  assert.equal(parser._isVideoCdnUrl(pathHlsUrl), false);
  assert.equal(parser._isVideoCdnUrl(hlsSegmentUrl), false);
  assert.deepEqual(noteCandidates.map((candidate) => candidate.url), [mp4Url]);
  assert.deepEqual(runtimeStreams.map((stream) => stream.url), [mp4Url]);
});

test("quality audit exposes anonymous candidates and the selection reason", () => {
  const parser = new XiaohongshuParser();
  const streams = parser._normalizeAvailableStreams([
    { url: "https://sns-video.xhscdn.com/1080.mp4", width: 1080, height: 1920, source: "note-stream-h265", codec: "h265" },
    { url: "https://sns-video.xhscdn.com/720.mp4", width: 720, height: 1280, source: "note-stream-h264", codec: "h264" },
  ], "https://www.xiaohongshu.com/");
  const audit = parser._buildQualityAudit(streams, streams[0]);

  assert.deepEqual(audit.advertisedQualities, ["1080x1920", "720x1280"]);
  assert.deepEqual(audit.accessibleQualities, ["1080x1920", "720x1280"]);
  assert.equal(audit.selectedQuality, "1080x1920");
  assert.match(audit.selectionReason, /resolution, frame rate, bitrate, and size/);
});

test("quality audit falls back to unknown when streams carry no quality metadata", () => {
  const parser = new XiaohongshuParser();
  const streams = parser._normalizeAvailableStreams([
    { url: "https://sns-video.xhscdn.com/origin.mp4", source: "origin-video-key" },
  ], "https://www.xiaohongshu.com/");
  const audit = parser._buildQualityAudit(streams, streams[0]);

  assert.deepEqual(audit.advertisedQualities, ["unknown"]);
  assert.deepEqual(audit.accessibleQualities, ["unknown"]);
  assert.equal(audit.selectedQuality, "unknown");
});

test("Xiaohongshu temporary feed API failures stay retryable", () => {
  const busy = classifyXiaohongshuFeedApiError("系统繁忙，请稍后再试");
  assert.equal(busy.code, "PLATFORM_API_ERROR");
  assert.equal(busy.permanent, false);
  assert.equal(busy.retryable, true);

  const deleted = classifyXiaohongshuFeedApiError("该笔记已被删除");
  assert.equal(deleted.code, "CONTENT_UNAVAILABLE");
  assert.equal(deleted.permanent, true);
  assert.equal(deleted.retryable, false);
});

test("Xiaohongshu later temporary feed errors do not demote permanent content failures", () => {
  let permanentError = preferPlatformError(null, classifyXiaohongshuFeedApiError("该笔记已被删除"));
  permanentError = preferPlatformError(permanentError, classifyXiaohongshuFeedApiError("系统繁忙，请稍后再试"));
  assert.equal(permanentError.code, "CONTENT_UNAVAILABLE");
  assert.equal(permanentError.permanent, true);

  // Body permanent upgrades sticky retryable feed error.
  permanentError = preferPlatformError(null, classifyXiaohongshuFeedApiError("系统繁忙"));
  permanentError = preferPlatformError(permanentError, new PlatformError("该笔记已被删除", {
    code: "CONTENT_DELETED",
    category: "content",
    permanent: true,
    retryable: false,
  }));
  assert.equal(permanentError.code, "CONTENT_DELETED");
  assert.equal(permanentError.permanent, true);
});
