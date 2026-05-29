import { EventEmitter } from "node:events";
import net from "node:net";
import type {
  Model,
  Api,
  Context,
  AssistantMessageEvent,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { describe, it, expect, vi, beforeAll } from "vitest";

// ── mock frame ──────────────────────────────────────────────────────────────

const mockFrames: Buffer[] = [];
let frameIndex = 0;

vi.mock("../src/frame.js", () => ({
  encodeFrame(payload: unknown) {
    return Buffer.from(JSON.stringify(payload), "utf8");
  },
  async readFrame(_socket: unknown, _timeoutMs: number) {
    if (frameIndex >= mockFrames.length) return null;
    const buf = mockFrames[frameIndex++];
    return JSON.parse(buf.toString("utf8")) as unknown;
  },
  readExact(_socket: unknown, _n: number) {
    return Promise.resolve(Buffer.alloc(0));
  },
}));

// ── mock transport ───────────────────────────────────────────────────────────

class MockSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  setNoDelay() {}
  write(_chunk: Buffer, cb?: (err?: Error) => void) {
    if (cb) cb();
    return true;
  }
  destroy() {
    this.destroyed = true;
  }
}

vi.mock("../src/transport.js", async () => {
  const actual = await vi.importActual("../src/transport.js");
  return {
    ...actual,
    connectSocketWithRetry: vi.fn(),
    connectSocket: vi.fn(),
  };
});

// Need to import after mocks
import {
  convertMessages,
  buildRequest,
  parseErrorFrame,
  createUnixSocketStreamFn,
} from "../src/stream.js";
import { connectSocketWithRetry } from "../src/transport.js";

const mockConnect = connectSocketWithRetry as ReturnType<typeof vi.fn>;

function makeMockSocket(): MockSocket {
  return new MockSocket();
}

function defaultConfig() {
  return {
    socketPath: "/tmp/test.sock",
    connectTimeoutMs: 5000,
    readTimeoutMs: 5000,
    maxRetries: 1,
  };
}

function makeModel(): Model<"openai-completions"> {
  return {
    id: "local-model",
    name: "local-model",
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

function makeContext(): Context {
  return {
    systemPrompt: "You are helpful.",
    messages: [{ role: "user", content: "Hello" }],
  };
}

function collectEvents(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  return (async () => {
    for await (const event of stream) {
      events.push(event);
    }
    return events;
  })();
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("convertMessages", () => {
  it("converts UserMessage to OpenAI format", () => {
    const result = convertMessages([{ role: "user", content: "Hello" }]);
    expect(result).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("injects system prompt", () => {
    const result = convertMessages([{ role: "user", content: "Hi" }], "Be helpful");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "system", content: "Be helpful" });
    expect(result[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("converts AssistantMessage with text", () => {
    const result = convertMessages([
      { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
    ]);
    expect(result).toEqual([{ role: "assistant", content: "Hello!" }]);
  });

  it("converts AssistantMessage with tool calls", () => {
    const result = convertMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "get_weather", arguments: { city: "NYC" } }],
      },
    ]);
    expect(result).toEqual([
      {
        role: "assistant",
        tool_calls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"NYC"}' },
          },
        ],
      },
    ]);
  });

  it("converts ToolResultMessage", () => {
    const result = convertMessages([{ role: "toolResult", toolCallId: "tc1", content: "72F" }]);
    expect(result).toEqual([{ role: "tool", tool_call_id: "tc1", content: "72F" }]);
  });
});

describe("buildRequest", () => {
  it("builds a streaming request", () => {
    const model = makeModel();
    const ctx = makeContext();
    const req = buildRequest(model, ctx, undefined, true);
    expect(req.model).toBe("local-model");
    expect(req.stream).toBe(true);
    expect(req.messages).toBeInstanceOf(Array);
  });

  it("includes tools when present", () => {
    const model = makeModel();
    const ctx: Context = {
      ...makeContext(),
      tools: [{ name: "get_weather", description: "Get weather", parameters: { type: "object" } }],
    };
    const req = buildRequest(model, ctx, undefined, false);
    expect(req.tools).toBeDefined();
    expect(req.tools as Array<unknown>).toHaveLength(1);
  });

  it("includes temperature when set", () => {
    const model = makeModel();
    const ctx = makeContext();
    const req = buildRequest(model, ctx, { temperature: 0.5 } as SimpleStreamOptions, false);
    expect(req.temperature).toBe(0.5);
  });

  it("applies max_tokens from model", () => {
    const model = makeModel();
    const ctx = makeContext();
    const req = buildRequest(model, ctx, undefined, false);
    expect(req.max_tokens).toBe(2048);
  });
});

describe("parseErrorFrame", () => {
  it("detects error field in response", () => {
    expect(parseErrorFrame({ error: { message: "Model not found", code: "404" } })).toBe(
      "Model not found",
    );
  });

  it("returns null for normal response", () => {
    expect(parseErrorFrame({ choices: [] })).toBeNull();
  });

  it("returns null for non-object", () => {
    expect(parseErrorFrame("string")).toBeNull();
    expect(parseErrorFrame(null)).toBeNull();
  });
});

describe("createUnixSocketStreamFn - streaming", () => {
  beforeAll(() => {
    vi.clearAllMocks();
  });

  it("emits start, text_delta, text_end, done for streaming text response", async () => {
    const mockSocket = makeMockSocket();
    mockConnect.mockResolvedValue(mockSocket);

    // Queue streaming frames
    mockFrames.length = 0;
    frameIndex = 0;
    mockFrames.push(
      Buffer.from(
        JSON.stringify({
          choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
        }),
      ),
      Buffer.from(
        JSON.stringify({
          choices: [{ index: 0, delta: { content: " world" }, finish_reason: "stop" }],
        }),
      ),
    );

    const fn = createUnixSocketStreamFn(defaultConfig());
    const stream = fn(makeModel(), makeContext(), undefined);
    const events = await collectEvents(stream);

    const types = events.map((e) => e.type);
    expect(types).toContain("start");
    expect(types).toContain("text_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("text_end");
    expect(types).toContain("done");
  });

  it("treats null frame (half-close) as graceful end after content", async () => {
    const mockSocket = makeMockSocket();
    mockConnect.mockResolvedValue(mockSocket);

    mockFrames.length = 0;
    frameIndex = 0;
    mockFrames.push(
      Buffer.from(
        JSON.stringify({
          choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
        }),
      ),
      // After this, the daemon does shutdown(SHUT_WR) -> readFrame returns null
    );

    const fn = createUnixSocketStreamFn(defaultConfig());
    const stream = fn(makeModel(), makeContext(), undefined);
    const events = await collectEvents(stream);

    const lastEvent = events[events.length - 1];
    expect(lastEvent!.type).toBe("done");
  });

  it("emits error event when first frame contains error", async () => {
    const mockSocket = makeMockSocket();
    mockConnect.mockResolvedValue(mockSocket);

    mockFrames.length = 0;
    frameIndex = 0;
    mockFrames.push(
      Buffer.from(JSON.stringify({ error: { message: "Model not loaded", code: "503" } })),
    );

    const fn = createUnixSocketStreamFn(defaultConfig());
    const stream = fn(makeModel(), makeContext(), undefined);
    const events = await collectEvents(stream);

    expect(events.some((e) => e.type === "error")).toBe(true);
    const errorEvent = events.find((e) => e.type === "error");
    expect(
      (errorEvent as { error: { errorMessage?: string } } | undefined)?.error?.errorMessage,
    ).toBe("Model not loaded");
  });
});

describe("createUnixSocketStreamFn - error handling", () => {
  it("emits error on connection failure", async () => {
    mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

    const fn = createUnixSocketStreamFn(defaultConfig());
    const stream = fn(makeModel(), makeContext(), undefined);
    const events = await collectEvents(stream);

    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("emits error when aborted before connection", async () => {
    const abort = new AbortController();
    abort.abort();

    const fn = createUnixSocketStreamFn(defaultConfig());
    const stream = fn(makeModel(), makeContext(), { signal: abort.signal });
    const events = await collectEvents(stream);

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as { reason: string } | undefined)?.reason).toBe("aborted");
  });
});
