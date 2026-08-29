import { PlatformError, PlatformParser, preferPlatformError } from "./base.js";
import { itemKey, sleep, settleWithin } from "../utils/common.js";

const URL_PATTERNS = [
  /^https?:\/\/(?:www\.)?xiaohongshu\.com\/(?:explore|discovery\/item)\/[\w]+/i,
  /^https?:\/\/(?:www\.)?xiaohongshu\.com\/note\/[\w]+/i,
  /^https?:\/\/xhslink\.(?:cn|com)\//i,
];

export function classifyXiaohongshuFeedApiError(msg) {
  const text = String(msg ?? "unknown");
  const permanent = /不存在|已删除|已被删除|违规|无法查看|私密/u.test(text);
  return new PlatformError(
    `Xiaohongshu feed API error: ${text}`,
    {
      code: permanent ? "CONTENT_UNAVAILABLE" : "PLATFORM_API_ERROR",
      category: permanent ? "content" : "platform",
      permanent,
      retryable: !permanent,
      retryScope: permanent ? "none" : "item",
      userMessage: permanent
        ? `小红书接口返回内容不可用：${text}，已跳过。`
        : `小红书接口返回异常：${text}，稍后会重新解析。`,
    },
  );
}

export class XiaohongshuParser extends PlatformParser {
  static getPlatformName() {
    return "小红书";
  }

  static matchesUrl(url) {
    return URL_PATTERNS.some((pattern) => pattern.test(url));
  }

  async parse(browserManager, url, options) {
    const browser = await browserManager.start();
    const contextOptions = XiaohongshuParser.getBrowserContextOptions(browserManager, options);

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    const feedApiData = [];
    const noteApiData = [];
    let permanentError = null;
    const runtimeMediaCandidates = [];
    const responseTasks = new Set();
    let closing = false;

    const addMediaCandidate = (candidate) => {
      if (
        !candidate?.url
        || /(?:mpegurl|m3u8|mp2t)/i.test(candidate.contentType ?? "")
        || !this._isVideoCdnUrl(candidate.url)
      ) return;
      const existing = runtimeMediaCandidates.find((item) => item.url === candidate.url);
      if (existing) {
        Object.assign(existing, Object.fromEntries(Object.entries(candidate).filter(([, value]) => value != null && value !== 0)));
        return;
      }
      runtimeMediaCandidates.push(candidate);
    };

    const handleResponse = (response) => {
      const task = (async () => {
      const responseUrl = response.url();
      const headers = response.headers();
      const contentType = headers["content-type"] ?? "";

      if (
        !/(?:mpegurl|m3u8|mp2t)/i.test(contentType)
        && (this._isVideoCdnUrl(responseUrl) || contentType.startsWith("video/"))
      ) {
        const total = Number(
          headers["content-range"]?.match(/\/(\d+)$/)?.[1] ?? headers["content-length"] ?? 0
        );
        addMediaCandidate({
          url: responseUrl,
          totalBytes: total,
          source: "media-response",
          contentType,
        });
      }

      // Intercept feed API
      if (/\/api\/sns\/web\/v1\/feed/.test(responseUrl) && response.ok()) {
        try {
          const json = await response.json();
          if (json.success && json.data) {
            feedApiData.push(json.data);
          } else if (!json.success) {
            permanentError = preferPlatformError(
              permanentError,
              classifyXiaohongshuFeedApiError(json.msg ?? "unknown"),
            );
          }
        } catch (e) { if (!closing) console.warn(`[xiaohongshu] failed to parse feed API response: ${e.message}`); }
      }

      // Intercept note API
      if (/\/api\/sns\/web\/v1\/note\/info/.test(responseUrl) && response.ok()) {
        try {
          const json = await response.json();
          if (json.success && json.data) {
            noteApiData.push(json.data);
          }
        } catch (e) { if (!closing) console.warn(`[xiaohongshu] failed to parse note API response: ${e.message}`); }
      }
      })().catch((error) => {
        if (!closing) console.warn(`[xiaohongshu] response handler failed: ${error.message}`);
      });
      responseTasks.add(task);
      task.finally(() => responseTasks.delete(task));
    };
    page.on("response", handleResponse);

    try {
      const ssrState = await this._fetchInitialState(context, url, options.pageTimeoutMs);
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: options.pageTimeoutMs,
      });

      const loginRedirect = this._extractLoginRedirect(page.url());
      if (loginRedirect && XiaohongshuParser.matchesUrl(loginRedirect)) {
        await page.goto(loginRedirect, {
          waitUntil: "domcontentloaded",
          timeout: options.pageTimeoutMs,
        });
      }

      const targetNoteId = this._extractNoteIdFromUrl(page.url())
        ?? this._extractNoteIdFromUrl(ssrState?.finalUrl)
        ?? this._extractNoteIdFromUrl(url);
      const ssrNote = this._extractNoteFromState(ssrState?.state, targetNoteId);

      // A known target ID must bind to that exact note. Unrelated feed cards and
      // runtime media are common on detail pages and must not end the wait early.
      const deadline = Date.now() + options.mediaWaitMs;
      while (this._collectNoteMediaCandidates(ssrNote).length === 0 && Date.now() < deadline) {
        if (await this._shouldStopWaitingForNote(
          page,
          feedApiData,
          noteApiData,
          targetNoteId,
          runtimeMediaCandidates,
          this._urlIndicatesVideo(page.url()),
        )) break;
        await sleep(250);
      }

      const finalUrl = page.url();
      const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
      for (const candidate of await this._collectRuntimeMediaCandidates(page)) {
        addMediaCandidate(candidate);
      }

      // Check for permanent failures (preferPlatformError can upgrade over retryable API noise)
      let bodyPermanentError = null;
      if (/该笔记已被删除|违规|无法查看|不存在/u.test(bodyText)) {
        const matched = bodyText.match(/该笔记已被删除|违规|无法查看|不存在/u)?.[0];
        bodyPermanentError = new PlatformError(matched, {
          code: /无法查看/u.test(matched) ? "CONTENT_PRIVATE" : "CONTENT_DELETED",
          category: "content",
          permanent: true,
          retryable: false,
          userMessage: `小红书笔记${matched}，已跳过。`,
        });
        permanentError = preferPlatformError(permanentError, bodyPermanentError);
      }

      // Do not continue with stale page/CDN fragments once content is permanently unavailable.
      if (bodyPermanentError) {
        throw permanentError;
      }

      const pageState = await this._extractNoteFromPage(page, targetNoteId);
      const apiNote = this._extractNoteFromApi(feedApiData, noteApiData, targetNoteId);
      const boundNotes = [ssrNote, pageState, apiNote].filter(Boolean);
      let noteData = boundNotes.find((note) => this._collectNoteMediaCandidates(note).length > 0)
        ?? boundNotes[0]
        ?? null;
      const bestRuntimeMediaCandidate = this._selectBestCdnCandidate(runtimeMediaCandidates);

      // Without a target ID, retain the legacy runtime-only fallback. Once the
      // target is known, arbitrary CDN traffic cannot stand in for target data.
      if (!noteData && !targetNoteId && bestRuntimeMediaCandidate) {
        noteData = {
          id: itemKey(url),
          type: "video",
          title: await page.title().catch(() => ""),
        };
      }

      if (!noteData) {
        if (permanentError) throw permanentError;
        throw new PlatformError("No Xiaohongshu note data found", {
          code: "MEDIA_DISCOVERY_FAILED",
          category: "platform",
          retryable: true,
          retryScope: "item",
          userMessage: "没有捕获到小红书笔记数据，稍后会重新解析。",
        });
      }

      const discoveredStreams = this._resolveAvailableStreams(
        noteData,
        runtimeMediaCandidates,
        "https://www.xiaohongshu.com/",
        this._noteDataIndicatesVideo(noteData) || this._urlIndicatesVideo(finalUrl),
      );
      const availableStreams = this._limitStreamsByQuality(discoveredStreams, options.maxVideoHeight);
      const videoUrl = availableStreams[0]?.url ?? null;

      // 判断是否为视频笔记
      const noteType = noteData.type ?? noteData.noteType ?? "";
      const hasVideo = noteType === "video" || noteData.video != null || Boolean(videoUrl) || this._urlIndicatesVideo(finalUrl);
      if (!hasVideo) {
        throw new PlatformError("This is an image/text note, not a video note", {
          code: "UNSUPPORTED_CONTENT_TYPE",
          category: "content",
          permanent: true,
          retryable: false,
          userMessage: "这是小红书图文笔记，不是可转写视频，已跳过。",
          suggestion: "如果需要处理图文内容，需要新增图片/文字提取能力。",
          details: { contentType: "image_note" },
        });
      }

      if (!videoUrl) {
        throw new PlatformError("No video URL found in note data", {
          code: "MEDIA_DISCOVERY_FAILED",
          category: "platform",
          retryable: true,
          retryScope: "item",
          userMessage: "没有找到小红书视频地址，稍后会重新解析。",
        });
      }

      // 提取元数据
      const noteId = noteData.noteId ?? noteData.id ?? this._extractNoteIdFromUrl(finalUrl) ?? itemKey(url);
      const user = noteData.user ?? noteData.author ?? {};

      const author = {
        nickname: user.nickname ?? user.nick_name ?? null,
        uid: user.userId ?? user.user_id ?? null,
        url: user.userId ? `https://www.xiaohongshu.com/user/profile/${user.userId}` : null,
      };

      const createTime = noteData.time ?? noteData.createTime ?? noteData.create_time;
      const postTime = createTime
        ? new Date(typeof createTime === "number" && createTime < 1e12 ? createTime * 1000 : createTime)
            .toISOString().replace("T", " ").slice(0, 19)
        : null;

      const interactInfo = noteData.interactInfo ?? noteData.interact_info ?? {};

      const statistics = {
        like_count: interactInfo.likedCount ?? interactInfo.liked_count ?? null,
        collect_count: interactInfo.collectedCount ?? interactInfo.collected_count ?? null,
        comment_count: interactInfo.commentCount ?? interactInfo.comment_count ?? null,
        share_count: interactInfo.shareCount ?? interactInfo.share_count ?? null,
      };

      const videoInfo = noteData.video ?? {};
      const duration = videoInfo.duration ?? videoInfo.dur ?? null;
      const mediaAlternatives = availableStreams.map((stream) => [{ ...stream }]);

      return {
        platform: XiaohongshuParser.getPlatformName(),
        sourceUrl: url,
        canonicalUrl: ssrState?.finalUrl ?? finalUrl,
        videoId: noteId,
        title: noteData.title ?? noteData.displayTitle ?? "",
        author,
        description: noteData.desc ?? null,
        postTime,
        duration: this._normalizeDuration(duration),
        statistics,
        referer: "https://www.xiaohongshu.com/",
        availableStreams,
        qualityAudit: this._buildQualityAudit(availableStreams, availableStreams[0]),
        mediaAlternatives,
        mediaStreams: mediaAlternatives[0],
      };
    } finally {
      closing = true;
      page.off("response", handleResponse);
      await settleWithin(Promise.allSettled([...responseTasks]), 5_000);
      await settleWithin(context.close(), 5_000);
    }
  }

  /**
   * Extract note data from intercepted API responses.
   */
  _extractNoteFromApi(feedData, noteData, targetNoteId = null) {
    // Direct note API
    const notePayloads = Array.isArray(noteData) ? noteData : [noteData];
    for (const payload of notePayloads) {
      const note = payload?.note_card ?? payload?.noteCard ?? payload?.note ?? payload;
      if (note && typeof note === "object" && this._noteMatches(note, targetNoteId)) {
        return note;
      }
    }

    // Feed API: response.data.items[n].note_card
    const feedPayloads = Array.isArray(feedData) ? feedData : [feedData];
    for (const payload of feedPayloads) {
      if (!payload?.items?.length) continue;
      const notes = payload.items
        .map((item) => item.note_card ?? item.noteCard ?? item)
        .filter(Boolean);
      const note = targetNoteId
        ? notes.find((candidate) => this._noteMatches(candidate, targetNoteId))
        : notes[0];
      if (note) return note;
    }

    return null;
  }

  _noteMatches(note, targetNoteId) {
    if (!targetNoteId) return true;
    const noteId = note?.noteId ?? note?.note_id ?? note?.id ?? note?.note_id_str ?? null;
    return String(noteId) === String(targetNoteId);
  }

  async _hasPageNoteState(page, targetNoteId) {
    return Boolean(await this._extractNoteFromPage(page, targetNoteId));
  }

  async _shouldStopWaitingForNote(
    page,
    feedData,
    noteData,
    targetNoteId,
    runtimeMediaCandidates = [],
    urlIndicatesVideo = false,
  ) {
    const apiNote = this._extractNoteFromApi(feedData, noteData, targetNoteId);
    const pageNote = await this._extractNoteFromPage(page, targetNoteId);
    const boundNote = pageNote ?? apiNote;
    const hasRuntimeMedia = runtimeMediaCandidates
      .some((candidate) => this._isVideoCdnUrl(candidate?.url));

    if (!boundNote) return !targetNoteId && hasRuntimeMedia;
    if (this._collectNoteMediaCandidates(boundNote).length > 0) return true;
    return hasRuntimeMedia && (this._noteDataIndicatesVideo(boundNote) || urlIndicatesVideo);
  }

  async _extractNoteFromPage(page, targetNoteId) {
    return await page.evaluate((noteId) => {
      const s = window.__INITIAL_STATE__;
      if (!s) return null;

      const unwrap = (entry) => entry?.note ?? entry ?? null;
      const noteIdOf = (note) => note?.noteId ?? note?.note_id ?? note?.id ?? note?.note_id_str ?? null;
      const matches = (note) => String(noteIdOf(note)) === String(noteId);
      const noteMap = s.note?.noteDetailMap ?? s.note?.data?.noteDetailMap;
      if (noteMap) {
        if (noteId) {
          const note = unwrap(noteMap[noteId]);
          const embeddedId = noteIdOf(note);
          if (note && (embeddedId == null || matches(note))) return note;
        } else {
          const firstKey = Object.keys(noteMap)[0];
          return firstKey ? unwrap(noteMap[firstKey]) : null;
        }
      }

      const note = unwrap(s.note?.note);
      if (note && (!noteId || matches(note))) return note;
      return null;
    }, targetNoteId).catch(() => null);
  }

  _extractLoginRedirect(url) {
    try {
      const parsed = new URL(url);
      if (!/xiaohongshu\.com$/i.test(parsed.hostname) && !/\.xiaohongshu\.com$/i.test(parsed.hostname)) return null;
      const redirectPath = parsed.searchParams.get("redirectPath");
      if (!redirectPath) return null;
      const redirect = new URL(redirectPath, parsed.origin);
      return redirect.href;
    } catch {
      return null;
    }
  }

  _urlIndicatesVideo(url) {
    try {
      return new URL(url).searchParams.get("type") === "video";
    } catch {
      return false;
    }
  }

  async _collectRuntimeMediaCandidates(page) {
    return await page.evaluate(() => {
      const candidates = [];
      const push = (url, source, totalBytes = 0) => {
        if (!url || !/^https?:\/\//i.test(url)) return;
        if (
          !/xhscdn\.com/i.test(url)
          || /m3u8/i.test(url)
          || /\/hls(?:[/?#]|$)/i.test(url)
          || /[?&](?:format|type|protocol)=hls(?:[&#]|$)/i.test(url)
          || /\.(?:ts|m2ts)(?:[?#]|$)/i.test(url)
        ) return;
        if (!/(\.mp4(?:[/?#]|$)|sns-video)/i.test(url)) return;
        if (candidates.some((item) => item.url === url)) return;
        candidates.push({ url, totalBytes, source });
      };

      for (const entry of performance.getEntriesByType("resource")) {
        push(entry.name, "performance-resource", entry.encodedBodySize || entry.transferSize || 0);
      }

      for (const video of document.querySelectorAll("video")) {
        const url = video.currentSrc || video.src;
        push(url, "video-current-src");
        const candidate = candidates.find((item) => item.url === url);
        if (candidate && video.videoWidth && video.videoHeight) {
          candidate.width = video.videoWidth;
          candidate.height = video.videoHeight;
        }
      }

      return candidates;
    }).catch(() => []);
  }

  _normalizeDuration(duration) {
    if (duration == null || duration === "") return null;
    const numeric = Number(duration);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    // Xiaohongshu fields vary by source: small values are seconds, large values are milliseconds.
    return numeric >= 1_000 ? Math.round(numeric / 1000) : Math.round(numeric);
  }

  /**
   * Extract video CDN URL from note data.
   */
  _extractVideoUrl(noteData) {
    return this._collectNoteMediaCandidates(noteData)[0]?.url ?? null;
  }

  _collectNoteMediaCandidates(noteData) {
    const video = noteData?.video ?? {};
    const mediaV2 = this._parseEmbeddedJson(video.mediaV2 ?? video.media_v2);
    const candidates = [
      ...this._collectStreamGroup(video.media?.stream, "note-stream"),
      ...this._collectStreamGroup(mediaV2?.stream ?? mediaV2?.media?.stream, "media-v2-stream"),
      ...this._collectMediaV2ScreencastCandidates(mediaV2),
    ];

    const originKey = video.consumer?.originVideoKey ?? video.originVideoKey;
    if (originKey) {
      candidates.push({
        url: /^https?:\/\//.test(originKey) ? originKey : `https://sns-video-bd.xhscdn.com/${originKey.replace(/^\//, "")}`,
        source: "origin-video-key",
      });
    }

    const directUrl = [video.url, video.downloadUrl]
      .find((url) => this._isVideoCdnUrl(url));
    if (directUrl) {
      candidates.push({ url: directUrl, source: "direct-video-url" });
    }

    const discoveredUrl = this._findCdnUrl(noteData);
    if (discoveredUrl) candidates.push({ url: discoveredUrl, source: "recursive-note-search" });
    const unique = [...new Map(
      candidates
        .filter((item) => this._isVideoCdnUrl(item.url))
        .map((item) => [item.url, item]),
    ).values()];
    return unique.sort((a, b) => this._compareCandidates(a, b));
  }

  async _fetchInitialState(context, url, timeout) {
    try {
      const response = await context.request.get(url, {
        timeout,
        headers: { "Accept-Language": "zh-CN,zh;q=0.9" },
      });
      if (!response.ok()) return null;
      const state = this._extractInitialStateFromHtml(await response.text());
      return state ? { state, finalUrl: response.url() } : null;
    } catch {
      return null;
    }
  }

  _extractInitialStateFromHtml(html) {
    const marker = "window.__INITIAL_STATE__=";
    const markerIndex = String(html ?? "").indexOf(marker);
    if (markerIndex < 0) return null;
    const start = html.indexOf("{", markerIndex + marker.length);
    const end = html.indexOf("</script>", start);
    if (start < 0 || end < 0) return null;
    const raw = this._replaceUndefinedLiterals(html.slice(start, end).trim().replace(/;$/, ""));
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  _replaceUndefinedLiterals(text) {
    let result = "";
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < text.length;) {
      const character = text[index];
      if (quoted) {
        result += character;
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        index += 1;
        continue;
      }
      if (character === '"') {
        quoted = true;
        result += character;
        index += 1;
        continue;
      }
      if (
        text.startsWith("undefined", index)
        && !/[\w$]/.test(text[index - 1] ?? "")
        && !/[\w$]/.test(text[index + 9] ?? "")
      ) {
        result += "null";
        index += 9;
        continue;
      }
      result += character;
      index += 1;
    }
    return result;
  }

  _extractNoteFromState(state, targetNoteId) {
    if (!state) return null;
    const unwrap = (entry) => entry?.note ?? entry ?? null;
    const noteMap = state.note?.noteDetailMap ?? state.note?.data?.noteDetailMap;
    if (noteMap) {
      if (targetNoteId) {
        const note = unwrap(noteMap[targetNoteId]);
        const embeddedId = note?.noteId ?? note?.note_id ?? note?.id ?? note?.note_id_str ?? null;
        if (note && (embeddedId == null || this._noteMatches(note, targetNoteId))) return note;
      } else {
        const firstKey = Object.keys(noteMap)[0];
        if (firstKey) return unwrap(noteMap[firstKey]);
      }
    }
    const note = unwrap(state.note?.note);
    return note && this._noteMatches(note, targetNoteId) ? note : null;
  }

  _collectStreamGroup(stream, sourcePrefix) {
    if (!stream || typeof stream !== "object") return [];
    return [
      ...this._tagStreams(stream.h264, "h264"),
      ...this._tagStreams(stream.h265, "h265"),
      ...this._tagStreams(stream.av1, "av1"),
      ...this._tagStreams(stream.h266, "h266"),
    ].map((item) => ({
      url: this._streamUrl(item),
      width: item.width ?? null,
      height: item.height ?? null,
      fps: item.fps ?? item.frameRate ?? item.frame_rate ?? null,
      bitrate: item.avgBitrate ?? item.avg_bitrate ?? item.videoBitrate ?? item.video_bitrate ?? item.bitrate ?? null,
      totalBytes: item.size ?? item.fileSize ?? item.file_size ?? null,
      codec: item.videoCodec ?? item.video_codec ?? item._codec,
      quality: item.qualityType ?? item.quality_type ?? item.quality ?? item.height ?? null,
      label: item.qualityLabel ?? item.quality_label ?? item.name ?? item.stream_desc ?? null,
      source: `${sourcePrefix}-${item._codec}`,
    }));
  }

  _collectMediaV2ScreencastCandidates(mediaV2) {
    const video = mediaV2?.video;
    if (!video || typeof video !== "object") return [];
    const opaque = this._parseEmbeddedJson(video.opaque1);
    if (!opaque || typeof opaque !== "object") return [];

    const sources = [
      ["hd_screencast_stream", "media-v2-hd-screencast"],
      ["default_screencast_stream", "media-v2-default-screencast"],
    ];
    return sources.flatMap(([field, source]) => {
      const value = opaque[field];
      const parsed = this._parseEmbeddedJson(value);
      const url = typeof value === "string" && this._isVideoCdnUrl(value)
        ? value
        : this._streamUrl(parsed);
      if (!url) return [];
      const isHd = field === "hd_screencast_stream";
      return [{
        url,
        width: isHd ? video.width ?? null : parsed?.width ?? null,
        height: isHd ? video.height ?? null : parsed?.height ?? null,
        fps: parsed?.fps ?? parsed?.frame_rate ?? (isHd ? video.fps ?? video.frame_rate : null) ?? null,
        bitrate: parsed?.avg_bitrate ?? parsed?.video_bitrate ?? null,
        totalBytes: parsed?.size ?? parsed?.file_size ?? null,
        quality: isHd ? video.height ?? null : parsed?.height ?? null,
        codec: parsed?.video_codec ?? parsed?.videoCodec ?? null,
        label: isHd ? "HD screencast" : "Default screencast",
        source,
      }];
    });
  }

  _parseEmbeddedJson(value) {
    if (value == null || typeof value === "object") return value;
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  _resolveAvailableStreams(noteData, runtimeMediaCandidates, referer, allowRuntimeFallback = false) {
    const noteStreams = this._normalizeAvailableStreams(
      this._collectNoteMediaCandidates(noteData),
      referer,
    );
    if (noteStreams.length > 0) return noteStreams;
    if (!allowRuntimeFallback && !this._noteDataIndicatesVideo(noteData)) return [];
    return this._normalizeAvailableStreams(runtimeMediaCandidates, referer);
  }

  _noteDataIndicatesVideo(noteData) {
    const noteType = noteData?.type ?? noteData?.noteType ?? "";
    return noteType === "video" || noteData?.video != null;
  }

  _tagStreams(streams, codec) {
    return (Array.isArray(streams) ? streams : [])
      .map((stream) => ({ ...stream, _codec: codec }))
      .filter((stream) => this._streamUrl(stream));
  }

  _streamUrl(stream) {
    return [stream?.masterUrl, stream?.master_url, stream?.url, ...(stream?.backupUrls ?? stream?.backup_urls ?? [])]
      .find((url) => this._isVideoCdnUrl(url)) ?? null;
  }

  _limitStreamsByQuality(streams, maxQuality) {
    if (!Number.isInteger(maxQuality) || maxQuality <= 0) return streams;
    const known = streams.filter((stream) => Number(stream.width) > 0 && Number(stream.height) > 0);
    if (known.length === 0) return streams;
    const allowed = known.filter((stream) => Math.min(Number(stream.width), Number(stream.height)) <= maxQuality);
    if (allowed.length === 0) {
      throw new PlatformError(`No Xiaohongshu stream is available at or below ${maxQuality}p`, {
        code: "QUALITY_LIMIT_UNAVAILABLE",
        category: "media",
        retryable: false,
        permanent: false,
        userMessage: `小红书未返回 ${maxQuality}p 及以下的视频流，未下载更高分辨率源文件。`,
      });
    }
    return allowed.sort((a, b) => this._compareCandidates(a, b));
  }

  _selectBestStream(streams) {
    const scored = streams
      .map((stream) => ({ stream, url: this._streamUrl(stream), score: this._streamScore(stream) }))
      .filter((item) => this._isVideoCdnUrl(item.url));
    scored.sort((a, b) => this._compareCandidates(a.stream, b.stream));
    return scored[0] ?? null;
  }

  _streamScore(stream) {
    const width = Number(stream?.width ?? 0);
    const height = Number(stream?.height ?? 0);
    const pixels = width * height;
    const fps = this._normalizeFps(stream?.fps ?? stream?.frameRate);
    const bitrate = Number(stream?.avgBitrate ?? stream?.videoBitrate ?? 0);
    const size = Number(stream?.size ?? 0);
    const codecScore = /^(?:h264|avc)$/i.test(stream?._codec ?? stream?.codec ?? "") ? 1 : 0;
    return pixels * 1e9 + fps * 1e6 + bitrate + Math.min(size, 1_000_000_000) / 1_000 + codecScore / 100;
  }

  _selectBestCdnCandidate(candidates) {
    const scored = candidates
      .filter((candidate) => this._isVideoCdnUrl(candidate.url))
      .map((candidate) => ({
        candidate,
        score: Number(candidate.totalBytes ?? 0) + (candidate.url.includes("sns-video") ? 1_000 : 0),
      }));
    scored.sort((a, b) => this._compareCandidates(a.candidate, b.candidate));
    return scored[0]?.candidate ?? null;
  }

  _normalizeFps(value) {
    if (typeof value === "string" && value.includes("/")) {
      const [numerator, denominator] = value.split("/").map(Number);
      return denominator ? numerator / denominator : 0;
    }
    const fps = Number(value ?? 0);
    return Number.isFinite(fps) ? fps : 0;
  }

  _compareCandidates(a, b) {
    const differences = [
      Number(b.width ?? 0) * Number(b.height ?? 0) - Number(a.width ?? 0) * Number(a.height ?? 0),
      this._normalizeFps(b.fps ?? b.frameRate) - this._normalizeFps(a.fps ?? a.frameRate),
      Number(b.bitrate ?? b.avgBitrate ?? b.videoBitrate ?? 0) - Number(a.bitrate ?? a.avgBitrate ?? a.videoBitrate ?? 0),
      Number(b.totalBytes ?? b.size ?? b.fileSize ?? 0) - Number(a.totalBytes ?? a.size ?? a.fileSize ?? 0),
      (/^(?:h264|avc)$/i.test(b.codec ?? b._codec ?? "") ? 1 : 0) - (/^(?:h264|avc)$/i.test(a.codec ?? a._codec ?? "") ? 1 : 0),
      (/note-stream/i.test(b.source ?? "") ? 1 : 0) - (/note-stream/i.test(a.source ?? "") ? 1 : 0),
    ];
    return differences.find((difference) => difference !== 0) ?? 0;
  }

  _normalizeAvailableStreams(candidates, referer) {
    const unique = new Map();
    for (const candidate of candidates) {
      if (!candidate?.url || !this._isVideoCdnUrl(candidate.url) || unique.has(candidate.url)) continue;
      const width = Number(candidate.width) || null;
      const height = Number(candidate.height) || null;
      const fps = this._normalizeFps(candidate.fps ?? candidate.frameRate) || null;
      const bitrate = Number(candidate.bitrate ?? candidate.avgBitrate ?? candidate.videoBitrate) || null;
      const totalBytes = Number(candidate.totalBytes ?? candidate.size ?? candidate.fileSize) || null;
      const quality = candidate.quality ?? height;
      const label = candidate.label ?? (width && height ? `${width}x${height}${fps ? `@${fps}` : ""}` : null);
      unique.set(candidate.url, {
        url: candidate.url,
        type: "video+audio",
        format: "mp4",
        width,
        height,
        fps,
        bitrate,
        codec: candidate.codec ?? candidate._codec ?? null,
        quality,
        label,
        source: candidate.source ?? null,
        totalBytes,
        referer,
      });
    }
    return [...unique.values()].sort((a, b) => this._compareCandidates(a, b));
  }

  _buildQualityAudit(availableStreams, selected) {
    // Streams from the origin-video-key / runtime fallback paths may carry no
    // quality metadata at all; keep the audit fields informative regardless.
    const qualities = [...new Set(availableStreams.map((stream) => {
      const value = stream.label ?? stream.quality;
      return value != null ? String(value) : null;
    }).filter(Boolean))];
    return {
      advertisedQualities: qualities.length ? qualities : ["unknown"],
      accessibleQualities: qualities.length ? qualities : ["unknown"],
      selectedQuality: selected ? String(selected.label ?? selected.quality ?? "unknown") : null,
      selectionReason: "highest anonymous stream by resolution, frame rate, bitrate, and size; codec/source only break quality ties",
      limitedBy: null,
    };
  }

  _isVideoCdnUrl(url) {
    return /^https?:\/\/[^\s"']*xhscdn\.com\//i.test(url)
      && !this._isHlsUrl(url)
      && /(sns-video|\.mp4(?:[/?#]|$))/i.test(url);
  }

  _isHlsUrl(url) {
    const text = String(url ?? "");
    return /m3u8/i.test(text)
      || /\/hls(?:[/?#]|$)/i.test(text)
      || /[?&](?:format|type|protocol)=hls(?:[&#]|$)/i.test(text)
      || /\.(?:ts|m2ts)(?:[?#]|$)/i.test(text);
  }

  /**
   * Deep search for CDN video URLs in the note data.
   */
  _findCdnUrl(obj, depth = 0) {
    if (depth > 10 || obj == null) return null;
    if (typeof obj === "string") {
      if (this._isVideoCdnUrl(obj)) return obj;
      return null;
    }
    if (Array.isArray(obj)) {
      for (const child of obj) {
        const found = this._findCdnUrl(child, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof obj === "object") {
      for (const child of Object.values(obj)) {
        const found = this._findCdnUrl(child, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Extract note ID from the URL.
   */
  _extractNoteIdFromUrl(url) {
    return url.match(/(?:explore|discovery\/item|note)\/([\w]+)/)?.[1] ?? null;
  }
}
