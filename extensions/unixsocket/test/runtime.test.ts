import { describe, it, expect } from "vitest";
import {
  UNIXSOCKET_DEFAULT_CONNECT_TIMEOUT_MS,
  UNIXSOCKET_DEFAULT_MAX_RETRIES,
  UNIXSOCKET_DEFAULT_READ_TIMEOUT_MS,
  UNIXSOCKET_LOCAL_AUTH_PLACEHOLDER,
} from "../src/defaults.js";
import {
  resolveConfiguredSocketPath,
  resolveConfiguredModelId,
  resolveConnectTimeoutMs,
  resolveReadTimeoutMs,
  resolveMaxRetries,
  shouldUseUnixSocketSyntheticAuth,
  isUnixSocketLocalAuthMarker,
} from "../src/runtime.js";

describe("resolveConfiguredSocketPath", () => {
  it("returns undefined when no config", () => {
    expect(resolveConfiguredSocketPath(undefined)).toBeUndefined();
  });

  it("returns socketPath from provider config", () => {
    expect(
      resolveConfiguredSocketPath({
        models: {
          providers: {
            unixsocket: {
              baseUrl: "http://127.0.0.1:1/v1",
              models: [],
              params: { socketPath: "/tmp/daemon.sock" },
            },
          },
        },
      } as never),
    ).toBe("/tmp/daemon.sock");
  });
});

describe("resolveConfiguredModelId", () => {
  it("returns undefined when no config", () => {
    expect(resolveConfiguredModelId(undefined)).toBeUndefined();
  });

  it("returns modelId from provider config", () => {
    expect(
      resolveConfiguredModelId({
        models: {
          providers: {
            unixsocket: {
              baseUrl: "http://127.0.0.1:1/v1",
              models: [],
              params: { modelId: "my-model" },
            },
          },
        },
      } as never),
    ).toBe("my-model");
  });
});

describe("resolveConnectTimeoutMs", () => {
  it("returns default when no config", () => {
    expect(resolveConnectTimeoutMs(undefined)).toBe(UNIXSOCKET_DEFAULT_CONNECT_TIMEOUT_MS);
  });

  it("returns configured value from params", () => {
    expect(
      resolveConnectTimeoutMs({
        models: {
          providers: {
            unixsocket: {
              baseUrl: "http://127.0.0.1:1/v1",
              models: [],
              params: { connectTimeoutMs: 5000 },
            },
          },
        },
      } as never),
    ).toBe(5000);
  });
});

describe("resolveReadTimeoutMs", () => {
  it("returns default when no config", () => {
    expect(resolveReadTimeoutMs(undefined)).toBe(UNIXSOCKET_DEFAULT_READ_TIMEOUT_MS);
  });

  it("returns configured value from params", () => {
    expect(
      resolveReadTimeoutMs({
        models: {
          providers: {
            unixsocket: {
              baseUrl: "http://127.0.0.1:1/v1",
              models: [],
              params: { readTimeoutMs: 60000 },
            },
          },
        },
      } as never),
    ).toBe(60000);
  });
});

describe("resolveMaxRetries", () => {
  it("returns default when no config", () => {
    expect(resolveMaxRetries(undefined)).toBe(UNIXSOCKET_DEFAULT_MAX_RETRIES);
  });

  it("returns configured value from params", () => {
    expect(
      resolveMaxRetries({
        models: {
          providers: {
            unixsocket: {
              baseUrl: "http://127.0.0.1:1/v1",
              models: [],
              params: { maxRetries: 5 },
            },
          },
        },
      } as never),
    ).toBe(5);
  });
});

describe("shouldUseUnixSocketSyntheticAuth", () => {
  it("always returns true", () => {
    expect(shouldUseUnixSocketSyntheticAuth()).toBe(true);
  });
});

describe("isUnixSocketLocalAuthMarker", () => {
  it("returns true for local auth placeholder", () => {
    expect(isUnixSocketLocalAuthMarker(UNIXSOCKET_LOCAL_AUTH_PLACEHOLDER)).toBe(true);
  });

  it("returns false for other values", () => {
    expect(isUnixSocketLocalAuthMarker("some-key")).toBe(false);
  });
});
