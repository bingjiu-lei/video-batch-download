import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PlatformError, preferPlatformError } from "../scripts/platforms/base.js";
import { DouyinParser } from "../scripts/platforms/douyin.js";
import { buildSignedDetailRequest, parseCookieHeader } from "../scripts/platforms/douyin-signing/detail-api.js";
import { getABogus } from "../scripts/platforms/douyin-signing/abogus.js";
import { downloadDouyinRangeChunks } from "../scripts/media/downloader.js";

const parser = new DouyinParser();

test("Douyin detail collection keeps video variants and never collects music audio", () => {
  const candidates = [];
  parser._collectMediaUrls({
    aweme_detail: {
      video: {
        width: 1080,
        height: 1920,
        dynamic_cover: {
          url_list: ["https://v3.douyinvod.com/aweme/v1/play/?cover_id=wrong"],
        },
        bit_rate: [
          {
            gear_name: "normal_720_1",
            bit_rate: 1_500_000,
            play_addr: {
              width: 720,
              height: 1280,
              data_size: 10_000,
              url_list: ["https://v3.douyinvod.com/aweme/v1/play/?video_id=720"],
            },
          },
          {
            gear_name: "normal_1080_1",
            bit_rate: 3_000_000,
            play_addr: {
              width: 1080,
              height: 1920,
              data_size: 20_000,
              url_list: ["https://v3.douyinvod.com/aweme/v1/play/?video_id=1080"],
            },
          },
        ],
      },
      music: {
        play_url: {
          url_list: ["https://v3.douyinvod.com/aweme/v1/play/?audio_id=wrong"],
        },
      },
    },
  }, candidates);

  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.type === "video+audio"));
  assert.ok(candidates.every((candidate) => !candidate.url.includes("audio_id")));
  assert.deepEqual(parser._extractAdvertisedQualities({
    aweme_detail: { video: { bit_rate: [{ gear_name: "720p" }, { gear_name: "1080p" }] } },
  }), ["720p", "1080p"]);
});

test("Douyin detail metadata keeps the static cover before dynamic cover", () => {
  const cover = parser._extractDetailMeta({
    aweme_detail: {
      video: {
        origin_cover: { url_list: ["https://example.test/origin.jpg"] },
        cover: { url_list: ["https://example.test/cover.jpg"] },
        dynamic_cover: { url_list: ["https://example.test/dynamic.jpg"] },
      },
    },
  });

  assert.equal(cover.cover_url, "https://example.test/origin.jpg");
});

test("Douyin anonymous selection ranks resolution above currentSrc and exposes fallbacks", () => {
  const currentSrc = parser._normalizeCandidate({
    url: "https://v3.douyinvod.com/aweme/v1/play/?video_id=current",
    type: "video+audio",
    source: "video-current-src",
    width: 720,
    height: 1280,
    bitrate: 4_000_000,
  });
  const best = parser._normalizeCandidate({
    url: "https://v3.douyinvod.com/aweme/v1/play/?video_id=best",
    type: "video+audio",
    source: "detail-json",
    width: 1080,
    height: 1920,
    bitrate: 3_000_000,
  });
  const candidates = [currentSrc, best].sort((a, b) => parser._compareCandidates(b, a));
  const alternatives = parser._buildMediaAlternatives(candidates);

  assert.equal(alternatives.length, 2);
  assert.equal(alternatives[0][0].url, best.url);
  assert.equal(alternatives[1][0].url, currentSrc.url);
  assert.equal(alternatives[0][0].type, "video+audio");
  assert.equal(alternatives[0][0].quality, 1080);
});

test("Douyin keeps only mirrors from the same source url_list", () => {
  const collected = [];
  parser._collectMediaUrls({
    aweme_detail: {
      video: {
        play_addr: {
          width: 1920,
          height: 1080,
          data_size: 12_345,
          url_list: [
            "https://v3.douyinvod.com/video.mp4",
            "https://v9.douyinvod.com/video.mp4",
          ],
        },
      },
    },
  }, collected);
  const alternatives = parser._buildMediaAlternatives(collected.map((item) => parser._normalizeCandidate(item)));

  assert.equal(alternatives.length, 1);
  assert.deepEqual(alternatives[0][0].alternativeUrls, [
    "https://v3.douyinvod.com/video.mp4",
    "https://v9.douyinvod.com/video.mp4",
  ]);
});

test("Douyin does not merge independent same-metadata media objects", () => {
  const candidates = ["v3", "v9"].map((host) => parser._normalizeCandidate({
    url: `https://${host}.douyinvod.com/video.mp4`,
    type: "video+audio",
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 3_000_000,
    totalBytes: 12_345,
  }));
  assert.equal(parser._buildMediaAlternatives(candidates).length, 2);
});

test("Douyin a_bogus keeps production random entropy", () => {
  const params = "device_platform=webapp&aid=6383&aweme_id=1234567890123456789";
  const fixed = { startTime: 1_790_000_000_000, endTime: 1_790_000_000_005 };
  const low = getABogus(params, "GET", { ...fixed, random1: 1000, random2: 2000, random3: 3000 });
  const high = getABogus(params, "GET", { ...fixed, random1: 9000, random2: 8000, random3: 7000 });
  assert.notEqual(low, high);
  assert.equal(low, getABogus(params, "GET", { ...fixed, random1: 1000, random2: 2000, random3: 3000 }));
});

test("Douyin range downloader switches CDN after a range failure", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "douyin-cdn-"));
  const output = path.join(directory, "video.part");
  t.after(async () => fsp.rm(directory, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    if (String(url).includes("bad.douyinvod.com")) {
      return new Response("unavailable", { status: 503 });
    }
    const range = options.headers.Range.match(/bytes=(\d+)-(\d+)/);
    const start = Number(range[1]);
    const end = Number(range[2]);
    return new Response(Buffer.alloc(end - start + 1, 7), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/4` },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const downloaded = await downloadDouyinRangeChunks({
    url: "https://bad.douyinvod.com/video.mp4",
    alternativeUrls: [
      "https://bad.douyinvod.com/video.mp4",
      "https://good.douyinvod.com/video.mp4",
    ],
    totalBytes: 4,
  }, output, {}, new AbortController());

  assert.equal(downloaded, true);
  assert.equal((await fsp.readFile(output)).length, 4);
  assert.deepEqual(calls, [
    "https://bad.douyinvod.com/video.mp4",
    "https://good.douyinvod.com/video.mp4",
  ]);
});

test("Douyin range downloader switches CDN when one request hangs", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "douyin-cdn-timeout-"));
  const output = path.join(directory, "video.part");
  t.after(async () => fsp.rm(directory, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    if (String(url).includes("hung.douyinvod.com")) {
      return await new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    }
    return new Response(Buffer.alloc(4, 9), {
      status: 206,
      headers: { "content-range": "bytes 0-3/4" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const downloaded = await downloadDouyinRangeChunks({
    url: "https://hung.douyinvod.com/video.mp4",
    alternativeUrls: ["https://good.douyinvod.com/video.mp4"],
    totalBytes: 4,
  }, output, {}, new AbortController(), { rangeRequestTimeoutMs: 1_000 });

  assert.equal(downloaded, true);
  assert.equal((await fsp.readFile(output)).length, 4);
  assert.deepEqual(calls, [
    "https://hung.douyinvod.com/video.mp4",
    "https://good.douyinvod.com/video.mp4",
  ]);
});

test("Douyin range downloader cancels a stalled response body before switching CDN", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "douyin-cdn-body-timeout-"));
  const output = path.join(directory, "video.part");
  t.after(async () => fsp.rm(directory, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("body-hung.douyinvod.com")) {
      return new Response(new ReadableStream({
        pull() {},
        cancel() {},
      }), {
        status: 206,
        headers: { "content-range": "bytes 0-3/4" },
      });
    }
    return new Response(Buffer.alloc(4, 5), {
      status: 206,
      headers: { "content-range": "bytes 0-3/4" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const downloaded = await downloadDouyinRangeChunks({
    url: "https://body-hung.douyinvod.com/video.mp4",
    alternativeUrls: ["https://good.douyinvod.com/video.mp4"],
    totalBytes: 4,
  }, output, {}, new AbortController(), { rangeRequestTimeoutMs: 1_000 });

  assert.equal(downloaded, true);
  assert.equal((await fsp.readFile(output)).length, 4);
  assert.deepEqual(calls, [
    "https://body-hung.douyinvod.com/video.mp4",
    "https://good.douyinvod.com/video.mp4",
  ]);
});

test("Douyin signed detail request carries the new UIFID web signature alongside a_bogus", () => {
  const request = buildSignedDetailRequest(
    "7688541667254652200",
    "UIFID_TEMP=test-uifid; sessionid=test-session",
    1_790_000_000,
  );
  const parsed = new URL(request.url);
  assert.ok(parsed.searchParams.get("a_bogus"));
  assert.equal(parsed.searchParams.get("uifid"), "test-uifid");
  assert.equal(parsed.searchParams.get("timestamp"), "1790000000");
  assert.ok(parsed.searchParams.get("x-secsdk-web-signature"));
  assert.equal(request.headers.uifid, "test-uifid");
  assert.equal(
    request.headers["x-secsdk-web-signature"],
    parsed.searchParams.get("x-secsdk-web-signature"),
  );
  assert.deepEqual(parseCookieHeader("a=1; b=two=parts"), { a: "1", b: "two=parts" });
});

test("Douyin signed detail parsing does not start Playwright when media is already available", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalCookie = process.env.DOUYIN_COOKIE;
  process.env.DOUYIN_COOKIE = "UIFID_TEMP=test-uifid";
  globalThis.fetch = async () => new Response(JSON.stringify({
    status_code: 0,
    aweme_detail: {
      aweme_id: "1234567890123456789",
      desc: "签名接口视频",
      video: {
        width: 1920,
        height: 1080,
        bit_rate: [{
          bit_rate: 1_000_000,
          play_addr: {
            width: 1920,
            height: 1080,
            data_size: 10_000,
            url_list: ["https://v3.douyinvod.com/aweme/v1/play/?video_id=signed"],
          },
        }],
      },
    },
  }), { status: 200 });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalCookie == null) delete process.env.DOUYIN_COOKIE;
    else process.env.DOUYIN_COOKIE = originalCookie;
  });
  let browserStarts = 0;
  const parsed = await new DouyinParser().parse({
    start: async () => {
      browserStarts += 1;
      throw new Error("browser should not start");
    },
  }, "https://www.douyin.com/video/1234567890123456789", {
    pageTimeoutMs: 1_000,
    mediaWaitMs: 0,
    maxVideoHeight: 1080,
  });

  assert.equal(browserStarts, 0);
  assert.equal(parsed.mediaStreams[0].url, "https://v3.douyinvod.com/aweme/v1/play/?video_id=signed");
});

test("Douyin 1080p limit uses the short edge and prefers 60fps at equal resolution", () => {
  const candidates = [
    parser._normalizeCandidate({
      url: "https://v3.douyinvod.com/1080-30.mp4",
      type: "video+audio",
      width: 1080,
      height: 1920,
      fps: 30,
    }),
    parser._normalizeCandidate({
      url: "https://v3.douyinvod.com/1080-60.mp4",
      type: "video+audio",
      width: 1080,
      height: 1920,
      fps: 60,
    }),
    parser._normalizeCandidate({
      url: "https://v3.douyinvod.com/2160-60.mp4",
      type: "video+audio",
      width: 2160,
      height: 3840,
      fps: 60,
    }),
  ];
  const limited = parser._limitCandidatesByHeight(candidates, 1080)
    .sort((a, b) => parser._compareCandidates(b, a));
  assert.equal(limited.length, 2);
  assert.equal(limited[0].fps, 60);
  assert.equal(limited[0].quality, 1080);
});

test("Douyin selection supports DASH pairs and safely typed direct play URLs", () => {
  const direct = parser._normalizeCandidate({
    url: "https://v3.douyinvod.com/aweme/v1/play/?video_id=verified",
    type: "video+audio",
    source: "media-response",
  });
  const unsafe = parser._normalizeCandidate({
    url: "https://v3.douyinvod.com/aweme/v1/play/?audio_id=unknown",
    source: "detail-json",
  });
  const video = parser._normalizeCandidate({
    url: "https://v3.douyinvod.com/path/media-video-avc1.mp4",
    width: 1080,
    height: 1920,
    bitrate: 5_000_000,
  });
  const audio = parser._normalizeCandidate({
    url: "https://v3.douyinvod.com/path/media-audio-und-mp4a.mp4",
    bitrate: 192_000,
  });

  assert.equal(direct.type, "video+audio");
  assert.equal(unsafe, null);
  assert.deepEqual(parser._buildMediaAlternatives([video, audio])[0].map((stream) => stream.type), ["video", "audio"]);
});

test("Douyin image notes are classified as unsupported content", () => {
  const error = parser._classifyUnsupportedDetail({
    aweme_detail: {
      aweme_type: 68,
      images: [{ url_list: ["https://example.test/image.jpg"] }],
      video: null,
    },
  }, "https://www.douyin.com/note/123456");

  assert.equal(error.code, "UNSUPPORTED_CONTENT_TYPE");
  assert.equal(error.category, "content");
  assert.equal(error.permanent, true);
  assert.equal(error.retryable, false);
  assert.match(error.userMessage, /图文作品|不是可转写视频/u);
});

test("Douyin empty image arrays are not enough to mark a video as an image note", () => {
  const error = parser._classifyUnsupportedDetail({
    aweme_detail: {
      aweme_type: 0,
      images: [],
      image_infos: [],
      video: null,
    },
  }, "https://www.douyin.com/video/123456");

  assert.equal(error, null);
});

test("Douyin detail deletion status is not masked by status_code zero", () => {
  const error = parser._classifyDetailStatus({
    status_code: 0,
    aweme_detail: { status: { is_delete: 1 } },
  });

  assert.equal(error.code, "CONTENT_DELETED");
  assert.equal(error.category, "content");
  assert.equal(error.permanent, true);
});

test("Douyin permanent detail errors are not overwritten by later retryable status", () => {
  const deleted = parser._classifyDetailStatus({
    status_code: 0,
    aweme_detail: { status: { is_delete: 1 } },
  });
  const imageNote = parser._classifyUnsupportedDetail({
    aweme_detail: {
      aweme_type: 68,
      images: [{ url_list: ["https://example.test/image.jpg"] }],
      video: null,
    },
  }, "https://www.douyin.com/note/123456");
  const retryableStatus = parser._classifyDetailStatus({
    status_code: 5,
    aweme_detail: { status: {} },
  });

  // Simulate response handler assignment order: permanent first, then a later retryable detail.
  let permanentError = null;
  permanentError = preferPlatformError(permanentError, deleted);
  permanentError = preferPlatformError(permanentError, retryableStatus);
  assert.equal(permanentError.code, "CONTENT_DELETED");
  assert.equal(permanentError.permanent, true);

  permanentError = preferPlatformError(permanentError, imageNote);
  permanentError = preferPlatformError(permanentError, retryableStatus);
  assert.equal(permanentError.code, "UNSUPPORTED_CONTENT_TYPE");
  assert.equal(permanentError.permanent, true);
  assert.equal(retryableStatus.retryable, true);

  // Body deleted text must upgrade over an earlier retryable detail status (not ??=).
  permanentError = preferPlatformError(null, retryableStatus);
  permanentError = preferPlatformError(permanentError, new PlatformError("已删除", {
    code: "CONTENT_DELETED",
    category: "content",
    permanent: true,
    retryable: false,
  }));
  assert.equal(permanentError.code, "CONTENT_DELETED");
  assert.equal(permanentError.permanent, true);
});
