/**
 * Unix Socket Provider — Stress Test
 *
 * Starts the mock daemon, then runs concurrent StreamFn calls to measure
 * throughput, latency, and error rate under load.
 *
 * Usage:
 *   # Terminal 1: start mock daemon
 *   python3 extensions/unixsocket/test/mock-daemon.py --socket /tmp/stress-daemon.sock --mode streaming
 *
 *   # Terminal 2: run stress test
 *   pnpm test extensions/unixsocket/test/stress.test.ts
 *
 *   # Or run a specific scenario:
 *   STRESS_CONCURRENCY=50 STRESS_REQUESTS=200 pnpm test extensions/unixsocket/test/stress.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Model, Api, Context, AssistantMessageEvent } from "@mariozechner/pi-ai";

// We import from the real (non-mocked) source so this is a true integration test.
import { createUnixSocketStreamFn } from "../src/stream.js";
import { resolveSocketPath } from "../src/models.js";
import { UNIXSOCKET_DEFAULT_CONNECT_TIMEOUT_MS, UNIXSOCKET_DEFAULT_READ_TIMEOUT_MS } from "../src/defaults.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const SOCKET_PATH = process.env.STRESS_SOCKET ?? "/tmp/stress-daemon.sock";
const CONCURRENCY = Number(process.env.STRESS_CONCURRENCY) || 10;
const TOTAL_REQUESTS = Number(process.env.STRESS_REQUESTS) || 50;

const streamFn = createUnixSocketStreamFn({
  socketPath: SOCKET_PATH,
  connectTimeoutMs: UNIXSOCKET_DEFAULT_CONNECT_TIMEOUT_MS,
  readTimeoutMs: UNIXSOCKET_DEFAULT_READ_TIMEOUT_MS,
  maxRetries: 1,
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeModel(id = "local-model"): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions" as const,
    provider: "unixsocket" as const,
    baseUrl: "http://127.0.0.1:1/v1",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 2048,
  };
}

function makeContext(message: string): Context {
  return {
    systemPrompt: "You are a helpful assistant.",
    messages: [{ role: "user" as const, content: message }],
  };
}

async function collectResponse(
  model: Model<Api>,
  context: Context,
): Promise<{ text: string; stopReason: string; durationMs: number; error?: string }> {
  const startedAt = Date.now();
  const eventStream = streamFn(model, context);

  let text = "";
  let stopReason = "unknown";
  let error: string | undefined;

  try {
    for await (const event of eventStream as AsyncIterable<AssistantMessageEvent>) {
      if (event.type === "text_delta") {
        text += (event as { delta?: string }).delta ?? "";
      } else if (event.type === "done") {
        stopReason = (event as { reason?: string }).reason ?? "stop";
      } else if (event.type === "error") {
        error = (event as { error?: { errorMessage?: string } }).error?.errorMessage ?? "unknown";
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return { text, stopReason, durationMs: Date.now() - startedAt, error };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("unixsocket stress", () => {
  beforeAll(() => {
    console.log(`\n[stress] socket=${SOCKET_PATH} concurrency=${CONCURRENCY} requests=${TOTAL_REQUESTS}\n`);
  });

  afterAll(() => {
    console.log("\n[stress] done\n");
  });

  it("sequential — warmup", { timeout: 60_000 }, async () => {
    const model = makeModel();
    const ctx = makeContext("Hello, stress test!");
    const result = await collectResponse(model, ctx);
    expect(result.error).toBeUndefined();
    expect(result.text.length).toBeGreaterThan(0);
  }, 60_000);

  it(`concurrent — ${CONCURRENCY} in-flight, ${TOTAL_REQUESTS} total`, { timeout: 300_000 }, async () => {
    const results: Array<{
      text: string;
      stopReason: string;
      durationMs: number;
      error?: string;
    }> = [];

    const startedAt = Date.now();

    // Run requests in batches to control concurrency.
    for (let i = 0; i < TOTAL_REQUESTS; i += CONCURRENCY) {
      const batch = Array.from(
        { length: Math.min(CONCURRENCY, TOTAL_REQUESTS - i) },
        (_, j) => {
          const model = makeModel();
          const ctx = makeContext(`Batch ${Math.floor(i / CONCURRENCY) + 1}, request ${j + 1}`);
          return collectResponse(model, ctx);
        },
      );

      const batchResults = await Promise.all(batch);
      results.push(...batchResults);
    }

    const totalMs = Date.now() - startedAt;

    // ─── Aggregate ─────────────────────────────────────────────────────────
    const succeeded = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    const durations = succeeded.map((r) => r.durationMs).sort((a, b) => a - b);

    const p50 = durations[Math.floor(durations.length * 0.5)] ?? 0;
    const p90 = durations[Math.floor(durations.length * 0.9)] ?? 0;
    const p99 = durations[Math.floor(durations.length * 0.99)] ?? 0;
    const avg = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const min = durations[0] ?? 0;
    const max = durations[durations.length - 1] ?? 0;

    // ─── Report ────────────────────────────────────────────────────────────
    console.log("\n═══════════════════════════════════════════════════════");
    console.log("  Unix Socket Provider — Stress Test Report");
    console.log("═══════════════════════════════════════════════════════");
    console.log(`  Socket:          ${SOCKET_PATH}`);
    console.log(`  Concurrency:     ${CONCURRENCY}`);
    console.log(`  Total requests:  ${TOTAL_REQUESTS}`);
    console.log(`  Succeeded:       ${succeeded.length}`);
    console.log(`  Failed:          ${failed.length}`);
    console.log(`  Success rate:    ${((succeeded.length / TOTAL_REQUESTS) * 100).toFixed(1)}%`);
    console.log(`  Total time:      ${totalMs}ms`);
    console.log(`  Throughput:      ${((TOTAL_REQUESTS / totalMs) * 1000).toFixed(1)} req/s`);
    console.log("───────────────────────────────────────────────────────");
    console.log("  Latency (ms):");
    console.log(`    min: ${min}  avg: ${avg.toFixed(0)}  max: ${max}`);
    console.log(`    p50: ${p50}  p90: ${p90}  p99: ${p99}`);
    console.log("───────────────────────────────────────────────────────");

    if (failed.length > 0) {
      console.log("  Errors:");
      const errorCounts = new Map<string, number>();
      for (const r of failed) {
        const key = r.error ?? "unknown";
        errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
      }
      for (const [msg, count] of errorCounts) {
        console.log(`    [${count}x] ${msg.slice(0, 120)}`);
      }
    }
    console.log("═══════════════════════════════════════════════════════\n");

    expect(succeeded.length).toBeGreaterThan(0);
  }, 300_000);
});
