import { EventEmitter } from "node:events";
import { type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { encodeFrame, readExact } from "../src/frame.js";

describe("encodeFrame", () => {
  it("generates 4-byte big-endian length header + JSON", () => {
    const payload = { model: "test", messages: [] };
    const frame = encodeFrame(payload);

    // First 4 bytes = big-endian length
    const length = frame.readUInt32BE(0);
    const json = JSON.stringify(payload);
    expect(length).toBe(Buffer.byteLength(json, "utf8"));

    // Remaining bytes = UTF-8 JSON
    const body = frame.subarray(4).toString("utf8");
    expect(body).toBe(json);
  });

  it("handles empty object", () => {
    const frame = encodeFrame({});
    const length = frame.readUInt32BE(0);
    expect(length).toBe(2); // "{}"
    expect(frame.subarray(4).toString("utf8")).toBe("{}");
  });

  it("handles UTF-8 multi-byte characters", () => {
    const payload = { content: "你好世界" };
    const frame = encodeFrame(payload);
    const length = frame.readUInt32BE(0);
    const json = JSON.stringify(payload);
    expect(length).toBe(Buffer.byteLength(json, "utf8"));
    expect(length).toBeGreaterThan(4); // multi-byte chars larger than char count
    expect(frame.subarray(4).toString("utf8")).toBe(json);
  });

  it("verifies big-endian byte order (MSB first)", () => {
    // Create a payload that is exactly 300 bytes
    const payload = { x: "a".repeat(268) }; // "{"x":"... plus 268 chars
    const expectedLen = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const frame = encodeFrame(payload);
    const byte0 = frame[0];
    const byte3 = frame[3];
    // MSB in byte 0 (for small lengths < 16MB)
    expect(expectedLen).toBeGreaterThan(255);
    expect(byte0).toBe(0); // MSB = 0 for < 16MB
    expect(byte3).toBeGreaterThan(0); // LSB has the remainder
  });
});

class MockReadableSocket extends EventEmitter {
  private buffers: Buffer[] = [];
  private index = 0;

  feed(buf: Buffer) {
    this.buffers.push(buf);
  }

  triggerData() {
    if (this.index < this.buffers.length) {
      this.emit("data", this.buffers[this.index++]!);
    }
  }

  unshift(buf: Buffer) {
    // Prepend for next read
    if (this.index > 0) {
      this.index--;
      this.buffers[this.index] = Buffer.concat([buf, this.buffers[this.index] ?? Buffer.alloc(0)]);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  removeListener(_event: string, _fn: unknown) {}

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  on(_event: string, _fn: unknown) {
    return this;
  }
}

function createMockSocket(): MockReadableSocket {
  return new MockReadableSocket();
}

describe("readExact", () => {
  it("reads exactly n bytes", async () => {
    const mock = createMockSocket();
    const expected = Buffer.from("hello world", "utf8");

    // Override on to capture data listener
    let dataListener: ((chunk: Buffer) => void) | null = null;
    const originalOn = mock.on.bind(mock);
    mock.on = function (event: string, fn: unknown) {
      if (event === "data") {
        dataListener = fn as (chunk: Buffer) => void;
      }
      return originalOn(event, fn);
    };

    const promise = readExact(mock as unknown as Socket, 11);

    // Simulate data arrival
    dataListener!(expected);

    const result = await promise;
    expect(result.toString("utf8")).toBe("hello world");
  });

  it("handles partial reads (data arrives in chunks)", async () => {
    const mock = createMockSocket();
    const expected = Buffer.from("abcdefghij", "utf8"); // 10 bytes

    let dataListener: ((chunk: Buffer) => void) | null = null;
    const originalOn = mock.on.bind(mock);
    mock.on = function (event: string, fn: unknown) {
      if (event === "data") {
        dataListener = fn as (chunk: Buffer) => void;
      }
      return originalOn(event, fn);
    };

    const promise = readExact(mock as unknown as Socket, 10);

    // Arrive in 3 chunks
    dataListener!(Buffer.from("abc", "utf8")); // 3 bytes
    dataListener!(Buffer.from("defg", "utf8")); // 4 bytes
    dataListener!(Buffer.from("hij", "utf8")); // 3 bytes

    const result = await promise;
    expect(result.toString("utf8")).toBe("abcdefghij");
  });

  it("handles sticky packets (unshift excess data)", async () => {
    const mock = createMockSocket();
    let dataListener: ((chunk: Buffer) => void) | null = null;
    let unshifted: Buffer | null = null;
    const originalOn = mock.on.bind(mock);
    mock.on = function (event: string, fn: unknown) {
      if (event === "data") {
        dataListener = fn as (chunk: Buffer) => void;
      }
      return originalOn(event, fn);
    };
    mock.unshift = function (buf: Buffer) {
      unshifted = buf;
    };

    // Request 5 bytes but feed 10
    const promise = readExact(mock as unknown as Socket, 5);
    dataListener!(Buffer.from("0123456789", "utf8"));

    const result = await promise;
    expect(result.toString("utf8")).toBe("01234");
    expect(unshifted!.toString("utf8")).toBe("56789");
  });

  it("rejects on socket error", async () => {
    const mock = createMockSocket();
    let errorListener: ((err: Error) => void) | null = null;
    const originalOn = mock.on.bind(mock);
    mock.on = function (event: string, fn: unknown) {
      if (event === "error") {
        errorListener = fn as (err: Error) => void;
      }
      return originalOn(event, fn);
    };

    const promise = readExact(mock as unknown as Socket, 10);
    errorListener!(new Error("socket broken"));

    await expect(promise).rejects.toThrow("socket broken");
  });
});
