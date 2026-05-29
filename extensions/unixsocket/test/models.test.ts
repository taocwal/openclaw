import { describe, it, expect } from "vitest";
import { UNIXSOCKET_DEFAULT_SOCKET_PATH, UNIXSOCKET_DEFAULT_MODEL_ID } from "../src/defaults.js";
import {
  resolveSocketPath,
  resolveModelId,
  buildUnixSocketModelDefinition,
} from "../src/models.js";

describe("resolveSocketPath", () => {
  it("returns default when no config", () => {
    expect(resolveSocketPath(undefined)).toBe(UNIXSOCKET_DEFAULT_SOCKET_PATH);
  });

  it("returns configured socketPath from params", () => {
    expect(
      resolveSocketPath({
        baseUrl: "http://127.0.0.1:1/v1",
        models: [],
        params: { socketPath: "/custom/path.sock" },
      } as never),
    ).toBe("/custom/path.sock");
  });

  it("returns default when params has no socketPath", () => {
    expect(
      resolveSocketPath({
        baseUrl: "http://127.0.0.1:1/v1",
        models: [],
        params: {},
      } as never),
    ).toBe(UNIXSOCKET_DEFAULT_SOCKET_PATH);
  });
});

describe("resolveModelId", () => {
  it("returns default when no config", () => {
    expect(resolveModelId(undefined)).toBe(UNIXSOCKET_DEFAULT_MODEL_ID);
  });

  it("returns configured modelId from params", () => {
    expect(
      resolveModelId({
        baseUrl: "http://127.0.0.1:1/v1",
        models: [],
        params: { modelId: "my-custom-model" },
      } as never),
    ).toBe("my-custom-model");
  });
});

describe("buildUnixSocketModelDefinition", () => {
  it("builds a valid ModelDefinitionConfig", () => {
    const def = buildUnixSocketModelDefinition(undefined);
    expect(def.id).toBe(UNIXSOCKET_DEFAULT_MODEL_ID);
    expect(def.name).toBe(UNIXSOCKET_DEFAULT_MODEL_ID);
    expect(def.reasoning).toBe(false);
    expect(def.input).toEqual(["text"]);
    expect(def.cost).toBeDefined();
    expect(def.contextWindow).toBe(4096);
    expect(def.maxTokens).toBe(2048);
  });

  it("uses configured modelId", () => {
    const def = buildUnixSocketModelDefinition({
      baseUrl: "http://127.0.0.1:1/v1",
      models: [],
      params: { modelId: "custom-model" },
    } as never);
    expect(def.id).toBe("custom-model");
  });
});
