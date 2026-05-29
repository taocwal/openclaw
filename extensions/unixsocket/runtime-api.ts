export {
  UNIXSOCKET_DEFAULT_SOCKET_PATH,
  UNIXSOCKET_PROVIDER_ID,
  UNIXSOCKET_PROVIDER_LABEL,
  UNIXSOCKET_LOCAL_AUTH_PLACEHOLDER,
  UNIXSOCKET_DEFAULT_MODEL_ID,
  UNIXSOCKET_DEFAULT_CONNECT_TIMEOUT_MS,
  UNIXSOCKET_DEFAULT_READ_TIMEOUT_MS,
  UNIXSOCKET_DEFAULT_MAX_RETRIES,
} from "./src/defaults.js";
export {
  resolveConfiguredModelId,
  resolveConfiguredSocketPath,
  resolveConnectTimeoutMs,
  resolveReadTimeoutMs,
  resolveMaxRetries,
  shouldUseUnixSocketSyntheticAuth,
  isUnixSocketLocalAuthMarker,
} from "./src/runtime.js";
export { resolveModelId, resolveSocketPath } from "./src/models.js";
export { configureUnixSocketNonInteractive, buildUnixSocketCatalog } from "./src/setup.js";
export { createUnixSocketStreamFn } from "./src/stream.js";
export { connectSocket, checkDaemon } from "./src/transport.js";
