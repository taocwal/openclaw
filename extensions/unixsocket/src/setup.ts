import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import type {
  ProviderAuthMethodNonInteractiveContext,
  ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-setup";
import {
  UNIXSOCKET_DEFAULT_CONNECT_TIMEOUT_MS,
  UNIXSOCKET_DEFAULT_MAX_RETRIES,
  UNIXSOCKET_DEFAULT_MODEL_ID,
  UNIXSOCKET_DEFAULT_READ_TIMEOUT_MS,
  UNIXSOCKET_DEFAULT_SOCKET_PATH,
  UNIXSOCKET_PROVIDER_ID,
} from "./defaults.js";
import { buildUnixSocketModelDefinition } from "./models.js";
import {
  resolveConfiguredModelId,
  resolveConfiguredSocketPath,
  resolveConnectTimeoutMs,
  resolveMaxRetries,
  resolveReadTimeoutMs,
} from "./runtime.js";

export async function configureUnixSocketNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
): Promise<OpenClawConfig | null> {
  const socketPath = resolveConfiguredSocketPath(ctx.config) ?? UNIXSOCKET_DEFAULT_SOCKET_PATH;
  const modelId = resolveConfiguredModelId(ctx.config) ?? UNIXSOCKET_DEFAULT_MODEL_ID;
  const connectTimeoutMs = resolveConnectTimeoutMs(ctx.config);
  const readTimeoutMs = resolveReadTimeoutMs(ctx.config);
  const maxRetries = resolveMaxRetries(ctx.config);

  return {
    models: {
      providers: {
        [UNIXSOCKET_PROVIDER_ID]: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          models: [
            buildUnixSocketModelDefinition(ctx.config.models?.providers?.[UNIXSOCKET_PROVIDER_ID]),
          ],
          params: {
            socketPath,
            modelId,
            connectTimeoutMs,
            readTimeoutMs,
            maxRetries,
          },
        },
      },
    },
  };
}

export async function buildUnixSocketCatalog(ctx: ProviderCatalogContext): Promise<{
  provider: ModelProviderConfig;
}> {
  const providerConfig = ctx.config.models?.providers?.[UNIXSOCKET_PROVIDER_ID];
  return {
    provider: {
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      models: [buildUnixSocketModelDefinition(providerConfig)],
    },
  };
}
