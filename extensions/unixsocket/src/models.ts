import fs from "node:fs";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { SELF_HOSTED_DEFAULT_COST } from "openclaw/plugin-sdk/provider-setup";
import { UNIXSOCKET_DEFAULT_MODEL_ID, UNIXSOCKET_DEFAULT_SOCKET_PATH } from "./defaults.js";

// ─── Socket path ─────────────────────────────────────────────────────────────

/** Resolve the Unix socket path from provider config. */
export function resolveSocketPath(providerConfig?: ModelProviderConfig): string {
  const params = providerConfig?.params as Record<string, unknown> | undefined;
  const configured = typeof params?.socketPath === "string" ? params.socketPath.trim() : "";
  return configured || UNIXSOCKET_DEFAULT_SOCKET_PATH;
}

// ─── Socket path validation ──────────────────────────────────────────────────

/**
 * Validate the configured socketPath. Throws with an error code and Chinese
 * message on invalid input so operators can fix configuration without decoding
 * system-level connect errors.
 */
export function validateSocketPath(socketPath: string): void {
  if (!socketPath || socketPath.trim() === "") {
    throw new Error("[E_VALIDATION_REQUIRED] socketPath 为必填项，不能为空");
  }
  if (/^https?:\/\//.test(socketPath.trim())) {
    throw new Error("[E_INVALID_SOCKET_PATH] Socket 路径格式错误，必须为本地文件路径");
  }
}

/**
 * Resolve the socket path from provider config, then validate and check
 * existence. Emits a warning log when the socket file does not exist so the
 * operator knows the daemon may not be running, but does not block the attempt.
 */
export function resolveAndValidateSocketPath(
  providerConfig?: ModelProviderConfig,
  log?: { warn: (msg: string, detail?: Record<string, unknown>) => void },
): string {
  const socketPath = resolveSocketPath(providerConfig);

  validateSocketPath(socketPath);

  if (!fs.existsSync(socketPath)) {
    log?.warn("unixsocket socketPath 不存在，等待服务启动后连接", {
      socketPath,
      configuredEmpty:
        !providerConfig || !(providerConfig?.params as Record<string, unknown>)?.socketPath,
    });
  }

  return socketPath;
}

/** Resolve the model ID from provider config. */
export function resolveModelId(providerConfig?: ModelProviderConfig): string {
  const params = providerConfig?.params as Record<string, unknown> | undefined;
  const configured = typeof params?.modelId === "string" ? params.modelId.trim() : "";
  return configured || UNIXSOCKET_DEFAULT_MODEL_ID;
}

/** Build a static model definition for the Unix Socket provider. */
export function buildUnixSocketModelDefinition(
  providerConfig?: ModelProviderConfig,
): ModelDefinitionConfig {
  const modelId = resolveModelId(providerConfig);
  return {
    id: modelId,
    name: modelId,
    reasoning: false,
    input: ["text"] as Array<"text" | "image" | "video" | "audio">,
    cost: SELF_HOSTED_DEFAULT_COST,
    contextWindow: 4096,
    maxTokens: 2048,
  };
}
