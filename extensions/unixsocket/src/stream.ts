import type { Socket } from "node:net";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
  type UserMessage,
  type AssistantMessage as PiAssistantMessage,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { UNIXSOCKET_PROVIDER_ID } from "./defaults.js";
import { encodeFrame, readFrame } from "./frame.js";
import { resolveAndValidateSocketPath } from "./models.js";
import { connectSocketWithRetry } from "./transport.js";

const log = createSubsystemLogger("extensions/unixsocket/stream");

// Bump this on every stream logic change. Printed in each request log so you
// can verify the deployed code matches what you expect.
const STREAM_IMPL_VERSION = 6;

type MutableAssistantOutput = Pick<
  AssistantMessage,
  "role" | "content" | "api" | "provider" | "model" | "usage" | "stopReason" | "timestamp"
> & { errorMessage?: string };

interface ThreadConfig {
  socketPath: string;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  maxRetries: number;
}

interface StreamingChunk {
  choices?: Array<{
    index: number;
    delta: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface NonStreamingResponse {
  choices?: Array<{
    index: number;
    message: {
      role: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface ErrorFrame {
  error?: { message: string; type?: string; code?: string };
}

// ─── Message conversion ─────────────────────────────────────────────────────

export function convertMessages(
  messages: Message[],
  systemPrompt?: string,
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];

  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    switch (msg.role) {
      case "user": {
        result.push({ role: "user", content: (msg as UserMessage).content });
        break;
      }
      case "assistant": {
        const assistantMsg = msg as PiAssistantMessage;
        const entry: Record<string, unknown> = { role: "assistant" };
        const textParts: string[] = [];
        const toolCalls: Record<string, unknown>[] = [];
        let thinkingText = "";

        for (const block of assistantMsg.content) {
          if (block.type === "text") textParts.push(block.text);
          else if (block.type === "thinking") thinkingText += block.thinking;
          else if (block.type === "toolCall") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: JSON.stringify(block.arguments) },
            });
          }
        }

        const content = textParts.join("");
        if (content) entry.content = content;
        else if (toolCalls.length === 0) entry.content = thinkingText || null;
        if (toolCalls.length > 0) entry.tool_calls = toolCalls;

        result.push(entry);
        break;
      }
      case "toolResult": {
        const toolMsg = msg as ToolResultMessage;
        const content = Array.isArray(toolMsg.content)
          ? toolMsg.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n")
          : typeof toolMsg.content === "string"
            ? toolMsg.content
            : JSON.stringify(toolMsg.content);
        result.push({ role: "tool", tool_call_id: toolMsg.toolCallId, content });
        break;
      }
    }
  }

  return result;
}

// ─── Request builder ─────────────────────────────────────────────────────────

export function buildRequest(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  stream: boolean,
): Record<string, unknown> {
  const messages = convertMessages(context.messages, context.systemPrompt);

  const body: Record<string, unknown> = {
    model: model.id,
    messages,
    stream,
  };

  if (context.tools && context.tools.length > 0) {
    body.tools = context.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  if (options?.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  const maxTokens = options?.maxTokens ?? model.maxTokens;
  if (maxTokens) {
    body.max_tokens = maxTokens;
  }

  return body;
}

// ─── Error detection ─────────────────────────────────────────────────────────

export function parseErrorFrame(frame: unknown): string | null {
  if (typeof frame !== "object" || frame === null) return null;
  const err = (frame as ErrorFrame).error;
  if (err && typeof err.message === "string") {
    return err.message;
  }
  return null;
}

// ─── Initial output ──────────────────────────────────────────────────────────

function createInitialOutput(model: Model<Api>): MutableAssistantOutput {
  return {
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

// ─── Socket error guard ──────────────────────────────────────────────────────

function guardSocketError(socket: Socket, socketPath: string): void {
  if (socket.listenerCount("error") === 0) {
    socket.on("error", (err: Error) => {
      log.warn("unixsocket socket error (guarded)", {
        socketPath,
        error: err.message,
      });
    });
  }
}

// ─── Streaming handler ───────────────────────────────────────────────────────

async function handleStreaming(
  socket: Socket,
  output: MutableAssistantOutput,
  config: ThreadConfig,
  stream: { push(event: unknown): void; end(result?: unknown): void },
  options: SimpleStreamOptions | undefined,
): Promise<void> {
  let contentIndex = 0;
  let hasTextContent = false;
  const pendingToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

  // Emit start event
  stream.push({ type: "start", partial: output as never });

  let frameCount = 0;

  while (true) {
    if (options?.signal?.aborted) throw new Error("Request was aborted");

    let frame: unknown;
    try {
      frame = await readFrame(socket, config.readTimeoutMs);
      frameCount++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // If we already have content, treat read errors as graceful end
      if (hasTextContent || pendingToolCalls.size > 0) {
        log.info("unixsocket stream ended by daemon close (content received)", {
          frameCount,
          hasText: hasTextContent,
          pendingToolCalls: pendingToolCalls.size,
          reason: errMsg,
        });
        break;
      }
      log.warn("unixsocket read error before any content", {
        frameCount,
        error: errMsg,
        socketDestroyed: socket.destroyed,
        readTimeoutMs: config.readTimeoutMs,
      });
      throw err;
    }

    // null frame means half-close (shutdown(SHUT_WR)) or zero-length payload
    if (frame === null) {
      break;
    }

    // Check for error frame
    const errorMsg = parseErrorFrame(frame);
    if (errorMsg) {
      log.warn("unixsocket error frame received", {
        error: errorMsg,
        rawFrame: JSON.stringify(frame).slice(0, 500),
      });
      throw new Error(errorMsg);
    }

    const chunk = frame as StreamingChunk;
    const choice = chunk.choices?.[0];
    if (!choice) {
      log.warn("unixsocket unexpected frame (no choices)", {
        frameKeys: Object.keys(frame as Record<string, unknown>),
        frameCount,
      });
      break;
    }

    // Auto-detect non-streaming response (choices[0].message).
    // The daemon forces stream=false so we receive a complete message.
    const message = (chunk as NonStreamingResponse).choices?.[0]?.message;
    if (message) {
      if (message.content) {
        hasTextContent = true;
        output.content.push({ type: "text", text: message.content });
        contentIndex = output.content.length - 1;
        stream.push({ type: "text_start", contentIndex, partial: output as never });
        stream.push({
          type: "text_delta",
          contentIndex,
          delta: message.content,
          partial: output as never,
        });
        stream.push({
          type: "text_end",
          contentIndex,
          content: message.content,
          partial: output as never,
        });
      }

      if (message.tool_calls) {
        for (const tc of message.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            args = {};
          }
          const toolCall: ToolCall = {
            type: "toolCall",
            id: tc.id,
            name: tc.function.name,
            arguments: args,
          };
          const ci = output.content.length;
          output.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: ci, partial: output as never });
          stream.push({
            type: "toolcall_delta",
            contentIndex: ci,
            delta: tc.function.arguments,
            partial: output as never,
          });
          stream.push({
            type: "toolcall_end",
            contentIndex: ci,
            toolCall,
            partial: output as never,
          });
        }
      }

      if (chunk.usage) {
        output.usage = {
          input: chunk.usage.prompt_tokens,
          output: chunk.usage.completion_tokens,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: chunk.usage.total_tokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      }

      output.stopReason =
        choice.finish_reason === "tool_calls"
          ? "toolUse"
          : choice.finish_reason === "length"
            ? "length"
            : "stop";

      break;
    }

    // Streaming format: choices[0].delta
    const delta = choice.delta;
    if (!delta) {
      log.warn("unixsocket frame has no delta and no message", {
        frameCount,
        finishReason: choice.finish_reason,
        keys: Object.keys(choice as Record<string, unknown>),
      });
      if (choice.finish_reason) break;
      continue;
    }

    // Handle text content
    if (delta?.content) {
      if (!hasTextContent) {
        hasTextContent = true;
        output.content.push({ type: "text", text: "" });
        contentIndex = output.content.length - 1;
        stream.push({ type: "text_start", contentIndex, partial: output as never });
      }
      const textDelta = delta.content;
      (output.content[contentIndex] as { type: "text"; text: string }).text += textDelta;
      stream.push({
        type: "text_delta",
        contentIndex,
        delta: textDelta,
        partial: output as never,
      });
    }

    // Handle tool calls (streaming: incremental)
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!pendingToolCalls.has(idx)) {
          pendingToolCalls.set(idx, {
            id: tc.id ?? "",
            name: tc.function?.name ?? "",
            args: "",
          });
        }
        const pending = pendingToolCalls.get(idx)!;
        if (tc.id) pending.id = tc.id;
        if (tc.function?.name) pending.name = tc.function.name;
        if (tc.function?.arguments) pending.args += tc.function.arguments;
      }
    }

    // Update usage
    if (chunk.usage) {
      output.usage = {
        input: chunk.usage.prompt_tokens,
        output: chunk.usage.completion_tokens,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: chunk.usage.total_tokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
    }

    // Check finish_reason
    const finishReason = choice.finish_reason;
    if (finishReason !== null && finishReason !== undefined) {
      output.stopReason =
        finishReason === "tool_calls" ? "toolUse" : finishReason === "length" ? "length" : "stop";

      // Emit text_end if we were streaming text
      if (hasTextContent) {
        const textBlock = output.content[contentIndex] as { type: "text"; text: string };
        stream.push({
          type: "text_end",
          contentIndex,
          content: textBlock.text,
          partial: output as never,
        });
      }

      // Emit tool calls
      for (const [, tc] of pendingToolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.args) as Record<string, unknown>;
        } catch {
          args = {};
        }
        const toolCall: ToolCall = {
          type: "toolCall",
          id: tc.id,
          name: tc.name,
          arguments: args,
        };
        const ci = output.content.length;
        output.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex: ci, partial: output as never });
        stream.push({
          type: "toolcall_delta",
          contentIndex: ci,
          delta: tc.args,
          partial: output as never,
        });
        stream.push({ type: "toolcall_end", contentIndex: ci, toolCall, partial: output as never });
      }

      break;
    }
  }

  stream.push({ type: "done", reason: output.stopReason as never, message: output as never });
}

// ─── Single-message content truncation ──────────────────────────────────────

function truncateMsgContent(
  msg: Record<string, unknown>,
  tokenBudget: number,
): Record<string, unknown> {
  const content = msg.content;
  if (typeof content !== "string") return msg;

  const maxChars = tokenBudget * 4;
  if (content.length <= maxChars) return msg;

  // Keep the beginning of the content where the most important instructions
  // live (system prompts, tool lists, safety rules are front-loaded).
  const truncated = content.slice(0, maxChars - 80);
  return { ...msg, content: `${truncated}\n\n[...truncated to fit context window]` };
}

// ─── Main entry point ────────────────────────────────────────────────────────

export function createUnixSocketStreamFn(config: ThreadConfig): StreamFn {
  return ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as {
      push(event: unknown): void;
      end(result?: unknown): void;
    };

    void (async () => {
      const output = createInitialOutput(model);

      let socket: Socket | null = null;

      try {
        if (options?.signal?.aborted) throw new Error("Request was aborted");

        const streamMode = true;
        const requestBody = buildRequest(model, context, options, streamMode);

        // Truncate context to fit within the model's context window.
        // Estimate: 4 chars ≈ 1 token (conservative for mixed content).
        const maxInputTokens = Math.max(
          0,
          model.contextWindow - (options?.maxTokens ?? model.maxTokens),
        );

        // Account for non-message request fields. Tools can consume 30K+
        // bytes and overwhelm a small context window. When overhead exceeds
        // the input budget, drop tools — the local daemon doesn't support
        // function calling anyway.
        let toolsDropped = false;
        let bodyWithoutMessages = { ...requestBody, messages: [] };
        let overheadTokens = Math.ceil(JSON.stringify(bodyWithoutMessages).length / 4);
        if (
          overheadTokens > maxInputTokens &&
          Array.isArray(requestBody.tools) &&
          requestBody.tools.length > 0
        ) {
          delete requestBody.tools;
          toolsDropped = true;
          bodyWithoutMessages = { ...requestBody, messages: [] };
          overheadTokens = Math.ceil(JSON.stringify(bodyWithoutMessages).length / 4);
        }
        const msgBudget = Math.max(256, maxInputTokens - overheadTokens);

        const rawMessages = requestBody.messages as Record<string, unknown>[];
        const originalMessageCount = rawMessages.length;

        // Build truncated messages from newest to oldest (recent messages are
        // more relevant). Always keep at least one message; truncate content
        // when a single message exceeds the remaining budget.
        const truncatedMessages: Record<string, unknown>[] = [];
        let usedTokens = 0;

        for (let i = rawMessages.length - 1; i >= 0; i--) {
          const msg = rawMessages[i];
          const remaining = msgBudget - usedTokens;
          const isLastResort = truncatedMessages.length === 0;
          if (remaining <= 0 && !isLastResort) break;

          const truncated = truncateMsgContent(msg, Math.max(256, remaining));
          const msgChars = JSON.stringify(truncated).length;
          usedTokens += Math.ceil(msgChars / 4);
          truncatedMessages.unshift(truncated);

          if (!isLastResort && usedTokens >= msgBudget) break;
        }
        requestBody.messages = truncatedMessages;

        log.info("unixsocket request", {
          provider: UNIXSOCKET_PROVIDER_ID,
          model: model.id,
          socketPath: config.socketPath,
          messages: `${truncatedMessages.length}/${originalMessageCount}`,
          estimatedTokens: usedTokens,
          maxTokens: options?.maxTokens ?? model.maxTokens,
          toolsDropped,
        });

        // Step 1: validate socketPath + check existence
        const socketPath = resolveAndValidateSocketPath(
          { params: { socketPath: config.socketPath } },
          { warn: (msg, detail) => log.warn(msg, detail as Record<string, unknown>) },
        );

        // Step 2: encode
        let requestFrame: Buffer;
        try {
          requestFrame = encodeFrame(requestBody);
        } catch (err) {
          log.warn("unixsocket encodeFrame failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }

        // Step 3: connect (with retry)
        socket = await connectSocketWithRetry(
          socketPath,
          config.connectTimeoutMs,
          config.maxRetries,
        );

        // Step 4: install error guard + write request frame
        guardSocketError(socket, socketPath);
        await new Promise<void>((resolve, reject) => {
          socket!.write(requestFrame, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Step 5: read response
        await handleStreaming(socket, output, config, stream, options);
        log.info("unixsocket response completed", {
          hasText: output.content.some((c) => c.type === "text"),
          contentBlocks: output.content.length,
          stopReason: output.stopReason,
          usage: output.usage,
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : JSON.stringify(error);
        const errStack = error instanceof Error ? error.stack : undefined;
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = errMsg;

        // Use log.error so the message is always visible regardless of log
        // level.  The core may wrap this into a cryptic TypeError later, so
        // the actionable message MUST be logged here.
        log.error("unixsocket 请求失败", {
          provider: UNIXSOCKET_PROVIDER_ID,
          model: model.id,
          socketPath: config.socketPath,
          error: errMsg,
          stack: errStack,
          hasContent: output.content.length > 0,
        });

        try {
          stream.push({
            type: "error",
            reason: output.stopReason as never,
            // Pass a shallow copy — the core may freeze/seal the object,
            // which would break stream.end(output) below.
            error: { ...output, content: [...output.content] },
          });
        } catch (pushErr) {
          // The core may throw TypeError when trying to decorate the output
          // object.  The real error is already logged above.
          log.warn("unixsocket stream.push error in catch", {
            error: pushErr instanceof Error ? pushErr.message : String(pushErr),
          });
        }
      } finally {
        try {
          if (socket && !socket.destroyed) {
            socket.removeAllListeners("error");
            socket.on("error", () => {
              /* noop — swallow late errors during teardown */
            });
            socket.destroy();
          }
        } catch (cleanupErr) {
          log.warn("unixsocket cleanup error", {
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
        try {
          stream.end(output as never);
        } catch (endErr) {
          log.warn("unixsocket stream.end error in finally", {
            error: endErr instanceof Error ? endErr.message : String(endErr),
          });
        }
      }
    })().catch((fatal) => {
      // Safety net: this should never fire because the try/catch inside the
      // async IIFE covers all awaited operations. If it does fire, a
      // synchronous throw escaped the try block — log it instead of crashing.
      log.warn("unixsocket unhandled rejection (safety net)", {
        error: fatal instanceof Error ? fatal.message : String(fatal),
        stack: fatal instanceof Error ? fatal.stack : undefined,
      });
    });

    return eventStream as unknown as ReturnType<StreamFn>;
  }) as StreamFn;
}
