import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { connectSocket, connectSocketWithRetry, checkDaemon } from "../src/transport.js";

class MockSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  write(_chunk: Buffer, cb?: (err?: Error) => void) {
    if (cb) cb();
    return true;
  }
  destroy(err?: Error) {
    this.destroyed = true;
    if (err) this.emit("error", err);
  }
}

function createMockConnection(socket: MockSocket): void {
  setTimeout(() => socket.emit("connect"), 0);
}

describe("connectSocket", () => {
  it("resolves with connected socket", async () => {
    const mockSocket = new MockSocket();
    const connectSpy = vi.spyOn(net, "createConnection").mockImplementation((() => {
      createMockConnection(mockSocket);
      return mockSocket as unknown as net.Socket;
    }) as typeof net.createConnection);

    const socket = await connectSocket("/tmp/test.sock", 5000);
    expect(socket).toBe(mockSocket);

    connectSpy.mockRestore();
  });

  it("rejects on connection timeout", async () => {
    const mockSocket = new MockSocket();
    const connectSpy = vi.spyOn(net, "createConnection").mockImplementation((() => {
      // never emit "connect"
      return mockSocket as unknown as net.Socket;
    }) as typeof net.createConnection);

    await expect(connectSocket("/tmp/nonexistent.sock", 50)).rejects.toThrow("connect timeout");

    connectSpy.mockRestore();
  });

  it("rejects on connection error", async () => {
    const mockSocket = new MockSocket();
    const connectSpy = vi.spyOn(net, "createConnection").mockImplementation((() => {
      setTimeout(() => mockSocket.emit("error", new Error("ENOENT: no such file")), 0);
      return mockSocket as unknown as net.Socket;
    }) as typeof net.createConnection);

    await expect(connectSocket("/tmp/missing.sock", 5000)).rejects.toThrow("no such file");

    connectSpy.mockRestore();
  });
});

describe("connectSocketWithRetry", () => {
  it("retries on failure and succeeds eventually", async () => {
    let attempts = 0;
    const mockSocket = new MockSocket();

    const connectSpy = vi.spyOn(net, "createConnection").mockImplementation((() => {
      attempts++;
      if (attempts < 3) {
        const failSocket = new MockSocket();
        setTimeout(() => failSocket.emit("error", new Error("ECONNREFUSED")), 0);
        return failSocket as unknown as net.Socket;
      }
      createMockConnection(mockSocket);
      return mockSocket as unknown as net.Socket;
    }) as typeof net.createConnection);

    const socket = await connectSocketWithRetry("/tmp/test.sock", 100, 3);
    expect(socket).toBe(mockSocket);
    expect(attempts).toBe(3);

    connectSpy.mockRestore();
  });

  it("throws after exceeding max retries", async () => {
    const connectSpy = vi.spyOn(net, "createConnection").mockImplementation((() => {
      const failSocket = new MockSocket();
      setTimeout(() => failSocket.emit("error", new Error("ECONNREFUSED")), 0);
      return failSocket as unknown as net.Socket;
    }) as typeof net.createConnection);

    await expect(connectSocketWithRetry("/tmp/test.sock", 50, 2)).rejects.toThrow("ECONNREFUSED");

    connectSpy.mockRestore();
  });
});

describe("checkDaemon", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns {ok:false} when socket file does not exist", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const result = await checkDaemon("/tmp/nonexistent.sock");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Socket file not found");
  });

  it("returns {ok:true} when connection succeeds", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const mockSocket = new MockSocket();
    const connectSpy = vi.spyOn(net, "createConnection").mockImplementation((() => {
      createMockConnection(mockSocket);
      return mockSocket as unknown as net.Socket;
    }) as typeof net.createConnection);

    const result = await checkDaemon("/tmp/test.sock");
    expect(result.ok).toBe(true);

    connectSpy.mockRestore();
  });

  it("returns {ok:false} when connection fails", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const mockSocket = new MockSocket();
    const connectSpy = vi.spyOn(net, "createConnection").mockImplementation((() => {
      setTimeout(() => mockSocket.emit("error", new Error("ECONNREFUSED")), 0);
      return mockSocket as unknown as net.Socket;
    }) as typeof net.createConnection);

    const result = await checkDaemon("/tmp/test.sock");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");

    connectSpy.mockRestore();
  });
});
