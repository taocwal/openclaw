/** Shared Unix Socket provider defaults. */
export const UNIXSOCKET_DEFAULT_SOCKET_PATH = "/var/run/ai-daemon.sock";
export const UNIXSOCKET_PROVIDER_LABEL = "Unix Socket";
export const UNIXSOCKET_LOCAL_AUTH_PLACEHOLDER = "unixsocket-local";
export const UNIXSOCKET_DEFAULT_MODEL_ID = "local-model";
export const UNIXSOCKET_PROVIDER_ID = "unixsocket";

export const UNIXSOCKET_DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const UNIXSOCKET_DEFAULT_READ_TIMEOUT_MS = 120_000;
export const UNIXSOCKET_DEFAULT_MAX_RETRIES = 3;
