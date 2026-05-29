import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import {
  UNIXSOCKET_DEFAULT_CONNECT_TIMEOUT_MS,
  UNIXSOCKET_DEFAULT_MAX_RETRIES,
  UNIXSOCKET_DEFAULT_MODEL_ID,
  UNIXSOCKET_DEFAULT_READ_TIMEOUT_MS,
  UNIXSOCKET_DEFAULT_SOCKET_PATH,
  UNIXSOCKET_LOCAL_AUTH_PLACEHOLDER,
  UNIXSOCKET_PROVIDER_ID,
  UNIXSOCKET_PROVIDER_LABEL,
} from "./src/defaults.js";
import { resolveSocketPath } from "./src/models.js";
import {
  resolveConfiguredModelId,
  resolveConfiguredSocketPath,
  resolveConnectTimeoutMs,
  resolveMaxRetries,
  resolveReadTimeoutMs,
} from "./src/runtime.js";
import { createUnixSocketStreamFn } from "./src/stream.js";

async function loadProviderSetup() {
  return await import("./src/setup.js");
}

export default definePluginEntry({
  id: UNIXSOCKET_PROVIDER_ID,
  name: "Unix Socket Provider",
  description: "Bundled Unix Socket provider plugin for on-device AI model daemon",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: UNIXSOCKET_PROVIDER_ID,
      label: UNIXSOCKET_PROVIDER_LABEL,
      docsPath: "/providers/unixsocket",
      auth: [
        {
          id: "custom",
          label: UNIXSOCKET_PROVIDER_LABEL,
          hint: "Local on-device AI model daemon via Unix Domain Socket",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            return {
              profiles: [],
              configPatch: {
                models: {
                  providers: {
                    [UNIXSOCKET_PROVIDER_ID]: {
                      baseUrl: "http://127.0.0.1:1/v1",
                      api: "openai-completions",
                      models: [],
                      params: {
                        socketPath:
                          resolveConfiguredSocketPath(ctx.config) ?? UNIXSOCKET_DEFAULT_SOCKET_PATH,
                        modelId:
                          resolveConfiguredModelId(ctx.config) ?? UNIXSOCKET_DEFAULT_MODEL_ID,
                      },
                    },
                  },
                },
              },
            };
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureUnixSocketNonInteractive(ctx);
          },
        },
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const providerSetup = await loadProviderSetup();
          return await providerSetup.buildUnixSocketCatalog(ctx);
        },
      },
      createStreamFn: (ctx) => {
        const providerConfig = ctx.config?.models?.providers?.[UNIXSOCKET_PROVIDER_ID];
        const socketPath = resolveSocketPath(providerConfig);
        const connectTimeoutMs = resolveConnectTimeoutMs(ctx.config);
        const readTimeoutMs = resolveReadTimeoutMs(ctx.config);
        const maxRetries = resolveMaxRetries(ctx.config);
        return createUnixSocketStreamFn({
          socketPath,
          connectTimeoutMs,
          readTimeoutMs,
          maxRetries,
        });
      },
      resolveSyntheticAuth: () => ({
        apiKey: CUSTOM_LOCAL_AUTH_MARKER,
        source: "models.providers.unixsocket (synthetic local key)",
        mode: "api-key" as const,
      }),
      shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
        resolvedApiKey?.trim() === UNIXSOCKET_LOCAL_AUTH_PLACEHOLDER ||
        resolvedApiKey?.trim() === CUSTOM_LOCAL_AUTH_MARKER,
      wizard: {
        setup: {
          choiceId: UNIXSOCKET_PROVIDER_ID,
          choiceLabel: "Unix Socket",
          choiceHint: "Local on-device AI model daemon via Unix Domain Socket",
          groupId: UNIXSOCKET_PROVIDER_ID,
          groupLabel: "Unix Socket",
          groupHint: "Local on-device AI models",
          methodId: "custom",
        },
      },
    });
  },
});
