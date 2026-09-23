import crypto from "node:crypto";
import { dirname } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

import { getABogus } from "./abogus.js";
import { baseRequestParams, urlencode } from "./params.js";

const DETAIL_ENDPOINT = "https://www.douyin.com/aweme/v1/web/aweme/detail/";
const DEFAULT_COOKIE_FILE = "D:/bilibili-video/douyin/cookie.txt";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export function parseCookieHeader(cookie) {
  return Object.fromEntries(String(cookie ?? "")
    .split(";")
    .map((part) => part.trim().split(/=(.*)/s, 2))
    .filter((pair) => pair.length === 2 && pair[0]));
}

export function buildSignedDetailRequest(awemeId, cookie, nowSeconds = Math.floor(Date.now() / 1000)) {
  const params = { ...baseRequestParams(""), aweme_id: String(awemeId) };
  const paramString = urlencode(params);
  const aBogus = getABogus(paramString, "GET");
  let signedQuery = `${paramString}&a_bogus=${encodeURIComponent(aBogus)}`;
  const cookies = parseCookieHeader(cookie);
  const uifid = cookies.UIFID_TEMP || cookies.UIFID || "";
  if (!uifid) return null;
  const verifyFp = cookies.s_v_web_id || "";
  if (verifyFp) signedQuery += `&verifyFp=${encodeURIComponent(verifyFp)}&fp=${encodeURIComponent(verifyFp)}`;
  const timestamp = String(nowSeconds);
  signedQuery += `&uifid=${encodeURIComponent(uifid)}&timestamp=${timestamp}`;
  const signature = crypto
    .createHash("md5")
    .update(`${uifid}_${timestamp}_A96D855A08C0A9707F8BEF0D9A527E4E_${signedQuery}`)
    .digest("hex");
  signedQuery += `&x-secsdk-web-signature=${signature}`;
  return {
    url: `${DETAIL_ENDPOINT}?${signedQuery}`,
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "zh-CN,zh;q=0.9",
      Referer: "https://www.douyin.com/",
      Cookie: cookie,
      uifid,
      "x-secsdk-web-signature": signature,
      "x-secsdk-web-expire": timestamp,
    },
  };
}

export async function mintDouyinGuestCookie(options = {}) {
  const cookieFile = process.env.DOUYIN_COOKIE_FILE || options.cookieFile || DEFAULT_COOKIE_FILE;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let browser = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      headless: true,
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: "zh-CN",
    });
    const page = await context.newPage();
    try {
      await page.goto("https://www.douyin.com/", {
        waitUntil: "domcontentloaded",
        timeout: Math.min(timeoutMs, 10_000),
      });
    } catch {
      // Non-fatal if domcontentloaded times out as long as initial cookies landed
    }
    await page.waitForTimeout(2_500);
    const cookies = await context.cookies();
    const cookiePairs = cookies.map((c) => `${c.name}=${c.value}`);
    const cookieStr = cookiePairs.join("; ");
    const parsed = parseCookieHeader(cookieStr);
    if (parsed.UIFID_TEMP || parsed.UIFID) {
      if (options.save !== false) {
        await mkdir(dirname(cookieFile), { recursive: true });
        await writeFile(cookieFile, cookieStr, "utf8");
      }
      return cookieStr;
    }
    return cookieStr || null;
  } catch {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export async function loadDouyinCookie(options = {}) {
  if (process.env.DOUYIN_COOKIE?.trim()) {
    const envCookie = process.env.DOUYIN_COOKIE.trim();
    const parsed = parseCookieHeader(envCookie);
    if (parsed.UIFID_TEMP || parsed.UIFID) return envCookie;
  }
  const cookieFile = process.env.DOUYIN_COOKIE_FILE || options.cookieFile || DEFAULT_COOKIE_FILE;
  let fileCookie = "";
  try {
    fileCookie = (await readFile(cookieFile, "utf8")).trim();
  } catch {
    fileCookie = "";
  }
  const parsed = parseCookieHeader(fileCookie);
  if (parsed.UIFID_TEMP || parsed.UIFID) {
    return fileCookie;
  }
  if (options.autoMint !== false && !options._minted) {
    const minted = await mintDouyinGuestCookie(options);
    if (minted) return minted;
  }
  return fileCookie;
}

export async function fetchSignedDouyinDetail(awemeId, options = {}) {
  let cookie = await loadDouyinCookie(options);
  let request = buildSignedDetailRequest(awemeId, cookie);
  if (!request && options.autoMint !== false && !options._minted) {
    cookie = await mintDouyinGuestCookie(options);
    request = buildSignedDetailRequest(awemeId, cookie);
  }
  if (!request) return null;

  const executeDetailQuery = async (req) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    try {
      const response = await fetch(req.url, {
        headers: req.headers,
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, status: response.status, json: null };
      const json = await response.json();
      return { ok: true, status: response.status, json };
    } catch {
      return { ok: false, status: 0, json: null };
    } finally {
      clearTimeout(timeout);
    }
  };

  let result = await executeDetailQuery(request);

  // If status is 403 (e.g. Uifid Not Found/Expired) or status_code is non-zero, retry once with fresh cookie
  if ((!result.ok || Number(result.json?.status_code ?? 0) !== 0 || !result.json?.aweme_detail)
      && options.autoMint !== false && !options._minted) {
    if (result.status === 403 || (result.json && Number(result.json.status_code) !== 0)) {
      const freshCookie = await mintDouyinGuestCookie({ ...options, _minted: true });
      if (freshCookie) {
        const retryRequest = buildSignedDetailRequest(awemeId, freshCookie);
        if (retryRequest) {
          result = await executeDetailQuery(retryRequest);
        }
      }
    }
  }

  if (!result.ok || !result.json) return null;
  const json = result.json;
  if (Number(json?.status_code ?? 0) !== 0 || !json?.aweme_detail) return null;
  if (String(json.aweme_detail.aweme_id ?? "") !== String(awemeId)) return null;
  return json;
}

export async function resolveDouyinUrl(url, timeoutMs = 15_000) {
  if (!/^https?:\/\/v\.douyin\.com\//i.test(url)) return url;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    const id = response.url.match(/\/(?:video|note)\/(\d+)/)?.[1];
    return id ? `https://www.douyin.com/video/${id}` : response.url;
  } catch {
    return url;
  } finally {
    clearTimeout(timeout);
  }
}
