#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  loadDouyinCookie,
  parseCookieHeader,
  mintDouyinGuestCookie,
  buildSignedDetailRequest,
  fetchSignedDouyinDetail,
  resolveDouyinUrl,
} from "../platforms/douyin-signing/detail-api.js";

const DEFAULT_TEST_AWEME_ID = "7688676779686464814";
const COOKIE_PATH = process.env.DOUYIN_COOKIE_FILE || "D:/bilibili-video/douyin/cookie.txt";

async function main() {
  console.log("==================================================");
  console.log("   🩺 Douyin Parser & Signature Doctor (抖音自检)");
  console.log("==================================================\n");

  const inputTarget = process.argv[2] || DEFAULT_TEST_AWEME_ID;
  let targetId = inputTarget;
  if (/^https?:\/\//i.test(inputTarget)) {
    console.log(`[1/5] 正在解析输入链接: ${inputTarget}`);
    const resolved = await resolveDouyinUrl(inputTarget);
    const matched = resolved.match(/\/(?:video|note)\/(\d+)/);
    targetId = matched ? matched[1] : inputTarget;
    console.log(`      解析到作品 ID: ${targetId}`);
  } else {
    console.log(`[1/5] 测试作品 ID: ${targetId}`);
  }

  // Step 2: Check local cookie file
  console.log(`\n[2/5] 检查本地 Cookie 文件: ${COOKIE_PATH}`);
  let cookieContent = "";
  if (fs.existsSync(COOKIE_PATH)) {
    cookieContent = fs.readFileSync(COOKIE_PATH, "utf8").trim();
    console.log(`      ✅ 文件存在，长度: ${cookieContent.length} 字符`);
  } else {
    console.log(`      ⚠️ 文件不存在，将尝试自动铸造访客 Cookie...`);
  }

  let parsed = parseCookieHeader(cookieContent);
  let uifid = parsed.UIFID_TEMP || parsed.UIFID;
  console.log(`      - UIFID: ${uifid ? "✅ 存在 (" + uifid.slice(0, 12) + "...)" : "❌ 缺失"}`);
  console.log(`      - ttwid: ${parsed.ttwid ? "✅ 存在 (" + parsed.ttwid.slice(0, 12) + "...)" : "⚠️ 未找到"}`);
  console.log(`      - verifyFp: ${parsed.s_v_web_id ? "✅ 存在" : "⚠️ 未找到"}`);

  // Step 3: Mint test if missing
  if (!uifid) {
    console.log(`\n[3/5] 正在自动铸造 (Auto-Mint) 访客 Cookie...`);
    const t0 = Date.now();
    const minted = await mintDouyinGuestCookie();
    if (minted) {
      console.log(`      ✅ 自动铸造成功，耗时 ${Date.now() - t0}ms`);
      parsed = parseCookieHeader(minted);
      uifid = parsed.UIFID_TEMP || parsed.UIFID;
      console.log(`      - 新 UIFID: ${uifid ? uifid.slice(0, 12) + "..." : "未知"}`);
      cookieContent = minted;
    } else {
      console.log(`      ❌ 自动铸造失败，请检查网络或 Playwright 环境`);
    }
  } else {
    console.log(`\n[3/5] Cookie 状态有效，跳过铸造`);
  }

  // Step 4: Signature check
  console.log(`\n[4/5] 测试 a_bogus & x-secsdk-web-signature 签名构建...`);
  const req = buildSignedDetailRequest(targetId, cookieContent);
  if (!req) {
    console.error(`      ❌ 签名构建失败：缺少必须的 UIFID 凭据`);
    process.exit(1);
  }
  const parsedUrl = new URL(req.url);
  console.log(`      ✅ 签名构建成功:`);
  console.log(`      - a_bogus: ${parsedUrl.searchParams.get("a_bogus")?.slice(0, 20)}...`);
  console.log(`      - x-secsdk-web-signature: ${req.headers["x-secsdk-web-signature"]}`);
  console.log(`      - x-secsdk-web-expire: ${req.headers["x-secsdk-web-expire"]}`);

  // Step 5: Live API test
  console.log(`\n[5/5] 向抖音官方接口发起真实请求...`);
  const startFetch = Date.now();
  const detail = await fetchSignedDouyinDetail(targetId, { timeoutMs: 15_000 });
  const latency = Date.now() - startFetch;

  if (!detail || !detail.aweme_detail) {
    console.error(`      ❌ 接口未返回有效的 aweme_detail 数据 (耗时 ${latency}ms)`);
    console.error(`      可能原因: Cookie 过期/被拉黑、视频下架或存在风控拦截。`);
    process.exit(1);
  }

  const aweme = detail.aweme_detail;
  const bitrates = aweme.video?.bit_rate || [];
  const gearNames = bitrates.map((b) => b.gear_name || "unknown");
  const has1080 = gearNames.some((g) => /1080/i.test(g));

  console.log(`      ✅ 接口请求成功！(耗时 ${latency}ms)`);
  console.log(`      - 视频标题: ${aweme.desc || "(无标题)"}`);
  console.log(`      - 作者昵称: ${aweme.author?.nickname || "(未知)"}`);
  console.log(`      - 视频清晰度档位: ${gearNames.join(", ") || "无"}`);
  console.log(`      - 1080p 超清源: ${has1080 ? "✅ 可用" : "⚠️ 未包含 1080p"}`);
  console.log(`      - 静态封面: ${aweme.video?.origin_cover?.url_list?.[0] ? "✅ 可用" : "❌ 未找到"}`);

  console.log("\n==================================================");
  console.log("   🎉 诊断结果: 抖音免浏览器签名直调链路完全正常！");
  console.log("==================================================");
}

main().catch((err) => {
  console.error("自检脚本执行异常:", err);
  process.exit(1);
});
