import fs from "node:fs";
import net from "node:net";
import {
  UNIXSOCKET_DEFAULT_CONNECT_TIMEOUT_MS,
  UNIXSOCKET_DEFAULT_MAX_RETRIES,
} from "./defaults.js";

export { UNIXSOCKET_DEFAULT_CONNECT_TIMEOUT_MS as SOCKET_CONNECT_TIMEOUT_MS };
export { UNIXSOCKET_DEFAULT_READ_TIMEOUT_MS as SOCKET_READ_TIMEOUT_MS } from "./defaults.js";

/**
 * Establish a Unix Domain Socket connection with timeout protection.
 * Returns the connected `net.Socket` on success.
 */
export function connectSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy(new Error(`Unix socket connect timeout: ${socketPath}`));
    }, timeoutMs);

    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Connect with exponential backoff retry. Returns the connected socket or
 * throws the last error after `maxRetries` attempts.
 */
export async function connectSocketWithRetry(
  socketPath: string,
  connectTimeoutMs: number,
  maxRetries: number,
): Promise<net.Socket> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await connectSocket(socketPath, connectTimeoutMs);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const backoff = Math.min(1000 * 2 ** attempt, 30_000);
        await delayMs(backoff);
      }
    }
  }

  throw lastError ?? new Error(`Failed to connect to ${socketPath}`);
}

/**
 * Health check: verify the daemon is reachable.
 * - Checks that the socket file exists on disk
 * - Attempts a connection to verify the daemon is listening
 */
export async function checkDaemon(socketPath: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    if (!fs.existsSync(socketPath)) {
      return { ok: false, error: `Socket file not found: ${socketPath}` };
    }

    const socket = await connectSocket(socketPath, 5_000);
    if (!socket.destroyed) {
      socket.destroy();
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
