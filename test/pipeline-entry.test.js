import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { QUALITY_SELECTION_VERSION } from "../scripts/core/policies.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "scripts", "download.mjs");

function runEntry(args) {
  return spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

test("download entry preserves help and option validation exit codes", () => {
  const help = runEntry(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);

  const invalid = runEntry(["--not-a-real-option"]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Unknown option/);
  assert.match(invalid.stdout, /Usage:/);
});

test("download entry warns for unmatched URLs and keeps the all-unmatched exit code", () => {
  const unsupported = "https://example.com/video/1";
  const result = runEntry([unsupported]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /\[routing\] warning: no loaded platform matched URL:/);
  assert.match(result.stderr, new RegExp(unsupported.replaceAll("/", "\\/")));
  assert.match(result.stderr, /No supported video URLs were found\./);
});

test("mixed batches report unmatched URLs without changing a successful exit code", async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "video-routing-entry-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const supported = "https://www.douyin.com/video/1234567890";
  const unsupported = "https://example.com/video/1";
  const resultJson = path.join(outputDir, "completed.json");
  await writeFile(resultJson, "{}", "utf8");
  await writeFile(path.join(outputDir, "download-state.json"), `${JSON.stringify({
    version: 2,
    updatedAt: new Date().toISOString(),
    items: {
      [supported]: {
        sourceUrl: supported,
        status: "completed",
        jsonPath: resultJson,
        selectionVersion: QUALITY_SELECTION_VERSION,
        accessMode: "anonymous",
        hasTranscript: false,
        videoOutput: false,
      },
    },
  }, null, 2)}\n`, "utf8");

  const result = runEntry([
    "--output", outputDir,
    "--no-transcribe",
    "--no-video-output",
    supported,
    unsupported,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[routing\] warning: no loaded platform matched URL:/);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.total, 1);
  assert.equal(summary.completed, 1);
  assert.deepEqual(summary.routing, {
    discovered: 2,
    matched: 1,
    unmatched: 1,
    unmatchedUrls: [unsupported],
  });
});

test("download entry clears only the requested temporary cache", async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "video-download-entry-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const tempDir = path.join(outputDir, ".temp");
  const itemDir = path.join(outputDir, "existing-result");
  await mkdir(tempDir);
  await mkdir(itemDir);
  await writeFile(path.join(tempDir, "cached.mp4"), "cache");
  await writeFile(path.join(itemDir, "result.json"), "{}");

  const result = runEntry(["--clear-temp", "--output", outputDir]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"status": "cleared"/);
  await assert.rejects(() => access(tempDir));
  await access(itemDir);
});
