#!/usr/bin/env node
// Isolated, bounded end-to-end latency check; never reads operator artifacts.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, arch, platform } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const binary = process.env.AG_TEST_BIN || resolve("ag/target/release/ag");
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "ag-perf-"));
try {
  const feed = join(root, "speech.jsonl"), images = join(root, "images");
  await writeFile(feed, Array.from({ length: 1000 }, (_, n) => JSON.stringify({ timestamp: `2026-09-22T12:00:00Z`, kind: "tts", session: "fixture", text: `record ${n}` })).join("\n") + "\n");
  await mkdir(join(images, "fixture"), { recursive: true });
  const bytes = Buffer.from("\x89PNG\r\n\x1a\nfixture"), sha256 = createHash("sha256").update(bytes).digest("hex");
  for (let n = 0; n < 200; n++) {
    const id = `fixture/img-${n}.png`;
    await writeFile(join(images, id), bytes);
    await writeFile(join(images, `${id}.json`), JSON.stringify({ version: 1, id, sha256, mimeType: "image/png", bytes: bytes.length, timestamp: `2026-09-22T12:00:00Z`, agent: "fixture" }));
  }
  const flags = ["--config", join(root, "absent.yaml"), "--local", "--json", "--tts-feed", feed, "--image-dir", images];
  const cases = [["startup", ["--version"], 1000], ["speech_100_of_1000", [...flags, "tts", "list", "--limit", "100"], 2000], ["images_100_of_200", [...flags, "image", "list", "--limit", "100"], 5000]];
  const results = [];
  for (const [name, args, budget] of cases) {
    const samples = [];
    for (let n = 0; n < 10; n++) {
      const start = performance.now();
      await run(binary, args, { timeout: 15_000, maxBuffer: 1024 * 1024 });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const ms = (n) => Math.round(samples[n] * 100) / 100;
    results.push({ name, samples: samples.length, p50_ms: ms(4), p95_ms: ms(9), p95_budget_ms: budget, passed: samples[9] <= budget });
  }
  console.log(JSON.stringify({ platform: platform(), arch: arch(), binary, results }, null, 2));
  if (results.some((r) => !r.passed)) process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }
