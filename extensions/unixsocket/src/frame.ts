import type { Socket } from "node:net";

/**
 * Encode a payload into a binary frame: 4-byte big-endian length header + UTF-8 JSON bytes.
 */
export function encodeFrame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Public: Read exactly `n` bytes from a socket, discarding any excess.
 * Prefer `readFrame` for protocol-level reads; this is exported for tests/tools.
 */
export function readExact(socket: Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;

    function onData(chunk: Buffer) {
      const needed = n - received;
      if (chunk.length <= needed) {
        chunks.push(chunk);
        received += chunk.length;
      } else {
        chunks.push(chunk.subarray(0, needed));
        received += needed;
        try {
          socket.unshift(chunk.subarray(needed));
        } catch {
          // unshift can fail if socket is already destroyed
        }
      }

      if (received >= n) {
        cleanup();
        resolve(Buffer.concat(chunks));
      }
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
    }

    socket.on("data", onData);
    socket.on("error", onError);
  });
}

/**
 * Internal: Read exactly `n` bytes, also returning any excess bytes read.
 * Avoids the unshift-and-drop issue by passing excess directly to caller.
 */
function readExactInternal(
  socket: Socket,
  n: number,
): Promise<{ data: Buffer; excess: Buffer | null }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let excess: Buffer | null = null;

    function onData(chunk: Buffer) {
      const needed = n - received;
      if (chunk.length <= needed) {
        chunks.push(chunk);
        received += chunk.length;
      } else {
        chunks.push(chunk.subarray(0, needed));
        received += needed;
        excess = chunk.subarray(needed);
      }

      if (received >= n) {
        cleanup();
        resolve({ data: Buffer.concat(chunks), excess });
      }
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
    }

    socket.on("data", onData);
    socket.on("error", onError);
  });
}

/**
 * Read bytes until the delimiter byte, socket end, or timeout.
 *
 * Returns the data (NOT including the delimiter) and any excess bytes after
 * the delimiter.
 */
function readUntilInternal(
  socket: Socket,
  delimiter: number,
): Promise<{ data: Buffer; excess: Buffer | null }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let excess: Buffer | null = null;

    function onData(chunk: Buffer) {
      const idx = chunk.indexOf(delimiter);
      if (idx >= 0) {
        chunks.push(chunk.subarray(0, idx));
        excess = chunk.subarray(idx + 1);
        cleanup();
        resolve({ data: Buffer.concat(chunks), excess });
      } else {
        chunks.push(chunk);
      }
    }

    function onEnd() {
      cleanup();
      resolve({ data: Buffer.concat(chunks), excess: null });
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("error", onError);
    }

    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);
  });
}

// ─── Timeout wrappers ──────────────────────────────────────────────────────

async function readExactWithTimeout(
  socket: Socket,
  n: number,
  timeoutMs: number,
): Promise<{ data: Buffer; excess: Buffer | null } | null> {
  const timer = setTimeout(() => {
    timerFired = true;
    if (!socket.destroyed) {
      socket.destroy(new Error(`Socket read timeout after ${timeoutMs}ms`));
    }
  }, timeoutMs);
  let timerFired = false;

  try {
    const result = await readExactInternal(socket, n);
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    if (timerFired && socket.destroyed) {
      return null;
    }
    throw err;
  }
}

async function readUntilWithTimeout(
  socket: Socket,
  delimiter: number,
  timeoutMs: number,
): Promise<{ data: Buffer; excess: Buffer | null } | null> {
  const timer = setTimeout(() => {
    timerFired = true;
    if (!socket.destroyed) {
      socket.destroy(new Error(`Socket read timeout after ${timeoutMs}ms`));
    }
  }, timeoutMs);
  let timerFired = false;

  try {
    const result = await readUntilInternal(socket, delimiter);
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    if (timerFired && socket.destroyed) {
      return null;
    }
    throw err;
  }
}

// ─── Public readFrame ──────────────────────────────────────────────────────

/**
 * Read one complete frame from the socket.
 *
 * Auto-detects the response format:
 * 1. Binary frame: 4-byte big-endian length header + JSON payload
 * 2. Newline-delimited: JSON followed by \n (used by some daemons like llama.cpp)
 *
 * Returns the parsed JSON object, or null when the socket is half-closed.
 */
export async function readFrame(socket: Socket, timeoutMs: number): Promise<unknown> {
  const headerResult = await readExactWithTimeout(socket, 4, timeoutMs);
  if (headerResult === null) return null;

  const { data: header, excess } = headerResult;

  // Auto-detect newline-delimited JSON: if the first byte is '{', the
  // response is plain JSON\n without a length-prefix header.
  if (header[0] === 0x7b) {
    // Try to find the delimiter in the excess bytes first.
    let restBuf: Buffer | null = null;
    let leftover: Buffer | null = excess;

    if (excess) {
      const nlIdx = excess.indexOf(0x0a);
      if (nlIdx >= 0) {
        // Delimiter found in excess — no need to read more from socket.
        restBuf = excess.subarray(0, nlIdx);
        const after = excess.subarray(nlIdx + 1);
        leftover = after.length > 0 ? after : null;
      } else {
        // Excess exists but no newline — need to read more.
        const moreResult = await readUntilWithTimeout(socket, 0x0a, timeoutMs);
        if (moreResult === null) {
          restBuf = excess;
        } else {
          restBuf = Buffer.concat([excess, moreResult.data]);
          leftover = moreResult.excess;
        }
      }
    } else {
      const result = await readUntilWithTimeout(socket, 0x0a, timeoutMs);
      if (result !== null) {
        restBuf = result.data;
        leftover = result.excess;
      }
    }

    // Push any leftover bytes back for the next readFrame call.
    if (leftover && leftover.length > 0) {
      try {
        socket.unshift(leftover);
      } catch {
        // unshift can fail if socket is already destroyed
      }
    }

    const full = restBuf ? Buffer.concat([header, restBuf]) : header;
    return JSON.parse(full.toString("utf8")) as unknown;
  }

  // Binary frame: 4-byte big-endian length header + JSON payload
  const payloadLength = header.readUInt32BE(0);
  if (payloadLength === 0) {
    // On binary frame with zero length, push excess back for next read.
    if (excess && excess.length > 0) {
      try {
        socket.unshift(excess);
      } catch {
        // ignore
      }
    }
    return null;
  }

  if (payloadLength > 10 * 1024 * 1024) {
    throw new Error(`Binary frame payload too large: ${payloadLength} bytes (max 10MB)`);
  }

  // If we already have enough excess to satisfy the payload, use it.
  // Otherwise read from socket. Prepend any excess we already have.
  let payload: Buffer;
  if (excess && excess.length >= payloadLength) {
    payload = excess.subarray(0, payloadLength);
    const after = excess.subarray(payloadLength);
    if (after.length > 0) {
      try {
        socket.unshift(after);
      } catch {
        // ignore
      }
    }
  } else {
    const needed = excess ? payloadLength - excess.length : payloadLength;
    const payloadResult = await readExactWithTimeout(socket, needed, timeoutMs);
    if (payloadResult === null) {
      // Timeout, push excess back
      if (excess && excess.length > 0) {
        try {
          socket.unshift(excess);
        } catch {
          // ignore
        }
      }
      return null;
    }
    payload = excess ? Buffer.concat([excess, payloadResult.data]) : payloadResult.data;
    // Push any new excess back
    if (payloadResult.excess && payloadResult.excess.length > 0) {
      try {
        socket.unshift(payloadResult.excess);
      } catch {
        // ignore
      }
    }
  }

  return JSON.parse(payload.toString("utf8")) as unknown;
}
