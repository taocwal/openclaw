import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  UNIXSOCKET_DEFAULT_CONNECT_TIMEOUT_MS,
  UNIXSOCKET_DEFAULT_MAX_RETRIES,
  UNIXSOCKET_DEFAULT_READ_TIMEOUT_MS,
  UNIXSOCKET_LOCAL_AUTH_PLACEHOLDER,
  UNIXSOCKET_PROVIDER_ID,
} from "./defaults.js";

/**
 * Resolve the configured Unix Socket path from provider config.
 */
export function resolveConfiguredSocketPath(config?: OpenClawConfig): string | undefined {
  const providerConfig = config?.models?.providers?.[UNIXSOCKET_PROVIDER_ID];
  if (!providerConfig) {
    return undefined;
  }
  const params = providerConfig.params as Record<string, unknown> | undefined;
  const configured = typeof params?.socketPath === "string" ? params.socketPath.trim() : "";
  return configured || undefined;
}

/**
 * Resolve the configured model ID from provider config.
 */
export function resolveConfiguredModelId(config?: OpenClawConfig): string | undefined {
  const providerConfig = config?.models?.providers?.[UNIXSOCKET_PROVIDER_ID];
  if (!providerConfig) {
    return undefined;
  }
  const params = providerConfig.params as Record<string, unknown> | undefined;
  const configured = typeof params?.modelId === "string" ? params.modelId.trim() : "";
  return configured || undefined;
}

/**
 * Resolve the connect timeout (ms) from provider config params.
 */
export function resolveConnectTimeoutMs(config?: OpenClawConfig): number {
  const params = config?.models?.providers?.[UNIXSOCKET_PROVIDER_ID]?.params as
    | Record<string, unknown>
    | undefined;
  const value = typeof params?.connectTimeoutMs === "number" ? params.connectTimeoutMs : undefined;
  return value ?? UNIXSOCKET_DEFAULT_CONNECT_TIMEOUT_MS;
}

/**
 * Resolve the read timeout (ms) from provider config params.
 */
export function resolveReadTimeoutMs(config?: OpenClawConfig): number {
  const params = config?.models?.providers?.[UNIXSOCKET_PROVIDER_ID]?.params as
    | Record<string, unknown>
    | undefined;
  const value = typeof params?.readTimeoutMs === "number" ? params.readTimeoutMs : undefined;
  return value ?? UNIXSOCKET_DEFAULT_READ_TIMEOUT_MS;
}

/**
 * Resolve the max retries from provider config params.
 */
export function resolveMaxRetries(config?: OpenClawConfig): number {
  const params = config?.models?.providers?.[UNIXSOCKET_PROVIDER_ID]?.params as
    | Record<string, unknown>
    | undefined;
  const value = typeof params?.maxRetries === "number" ? params.maxRetries : undefined;
  return value ?? UNIXSOCKET_DEFAULT_MAX_RETRIES;
}

/**
 * Check if the provider should use synthetic (placeholder) auth.
 */
export function shouldUseUnixSocketSyntheticAuth(): boolean {
  return true;
}

/**
 * Check if the resolved API key is a local placeholder marker.
 */
export function isUnixSocketLocalAuthMarker(apiKey: string): boolean {
  return apiKey.trim() === UNIXSOCKET_LOCAL_AUTH_PLACEHOLDER;
}
