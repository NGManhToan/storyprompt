import { cfNeurons } from "../laneLimits.js";
import { parseRetryAfter, ProviderError } from "../errors.js";
import type { GenerateRequest, GenerateResponse } from "../types.js";

type Fetch = typeof fetch;

function combinedSignal(signal?: AbortSignal, ms = 120_000): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function errorFrom(response: Response, lane: string): Promise<ProviderError> {
  const retryAfterMs =
    parseRetryAfter(response.headers.get("retry-after")) ??
    (/^\d+(?:\.\d+)?s$/.test(response.headers.get("x-ratelimit-reset-tokens") ?? "")
      ? parseRetryAfter(response.headers.get("x-ratelimit-reset-tokens")!.replace(/s$/, ""))
      : undefined);
  let message = `${lane} HTTP ${response.status}`;
  try {
    const body = (await response.json()) as {
      error?: { message?: string } | string;
      message?: string;
      errors?: { message?: string }[];
    };
    if (typeof body.error === "string") message = body.error;
    else if (body.error?.message) message = body.error.message;
    else if (body.errors?.[0]?.message) message = body.errors[0].message;
    else if (body.message) message = body.message;
  } catch {
    /* giữ mã HTTP */
  }
  return new ProviderError(message.slice(0, 400), { status: response.status, lane, retryAfterMs });
}

/** Lỗi 400 do nhà cung cấp không nhận json_schema → hạ xuống json_object một lần và nhớ lại. */
function schemaRejected(error: ProviderError): boolean {
  return error.status === 400 && /json_schema|response_format|schema|structured/i.test(error.message);
}

const groqNoSchema = new Set<string>();
const cfNoSchema = new Set<string>();

export function groqReasoning(model: string): Record<string, unknown> {
  if (/qwen3/i.test(model)) return { reasoning_effort: "none" };
  if (/gpt-oss/i.test(model)) return { reasoning_effort: "low" };
  return {};
}

export function buildGroqBody(model: string, request: GenerateRequest, useSchema: boolean): Record<string, unknown> {
  return {
    model,
    temperature: request.temperature,
    max_tokens: request.maxOutputTokens,
    ...groqReasoning(model),
    response_format: useSchema
      ? {
          type: "json_schema",
          json_schema: { name: request.kind === "bible" ? "story_bible" : "scene_prompts", schema: request.responseSchema, strict: false },
        }
      : { type: "json_object" },
    messages: [
      { role: "system", content: `${request.systemText}\nReturn JSON only.` },
      { role: "user", content: request.promptText },
    ],
  };
}

export async function generateGroq(options: {
  apiKey: string;
  model: string;
  request: GenerateRequest;
  signal?: AbortSignal;
  fetchImpl?: Fetch;
}): Promise<GenerateResponse> {
  if (!options.apiKey) throw new ProviderError("Thiếu Groq API key.", { status: 401, lane: "groq" });
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const post = (useSchema: boolean) =>
    fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(buildGroqBody(options.model, options.request, useSchema)),
      signal: combinedSignal(options.signal),
    });
  let useSchema = !groqNoSchema.has(options.model);
  let response = await post(useSchema);
  if (!response.ok) {
    const error = await errorFrom(response, "groq");
    if (!useSchema || !schemaRejected(error)) throw error;
    groqNoSchema.add(options.model);
    useSchema = false;
    response = await post(false);
    if (!response.ok) throw await errorFrom(response, "groq");
  }
  const payload = (await response.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    model?: string;
  };
  const promptTokens = payload.usage?.prompt_tokens ?? 0;
  const outputTokens = payload.usage?.completion_tokens ?? 0;
  return {
    text: payload.choices?.[0]?.message?.content ?? "",
    finishReason: payload.choices?.[0]?.finish_reason ?? "stop",
    model: payload.model ?? options.model,
    lane: "groq",
    usage: {
      promptTokens,
      outputTokens,
      totalTokens: payload.usage?.total_tokens ?? promptTokens + outputTokens,
    },
  };
}

export function cfReasoning(model: string): Record<string, unknown> {
  // qwen3.8-27b trên Workers AI chỉ nhận low/medium/xhigh (mặc định xhigh) — đặt low để giữ neuron.
  if (/qwen3\.8|gpt-oss/i.test(model)) return { reasoning_effort: "low" };
  return {};
}

export function buildCloudflareBody(model: string, request: GenerateRequest, useSchema: boolean): Record<string, unknown> {
  return {
    messages: [
      { role: "system", content: `${request.systemText}\nReturn JSON only.` },
      { role: "user", content: request.promptText },
    ],
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    ...cfReasoning(model),
    ...(useSchema ? { response_format: { type: "json_schema", json_schema: request.responseSchema } } : {}),
  };
}

type CfResult = {
  response?: string | Record<string, unknown>;
  choices?: { finish_reason?: string; message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

export async function generateCloudflare(options: {
  token: string;
  accountId: string;
  model: string;
  request: GenerateRequest;
  signal?: AbortSignal;
  fetchImpl?: Fetch;
}): Promise<GenerateResponse> {
  if (!options.token || !options.accountId) {
    throw new ProviderError("Thiếu Cloudflare account hoặc token.", { status: 401, lane: "cloudflare" });
  }
  if (!/^[@A-Za-z0-9_./:-]+$/.test(options.model)) {
    throw new ProviderError("Tên model Cloudflare không hợp lệ.", { status: 400, lane: "cloudflare" });
  }
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const post = (useSchema: boolean) =>
    fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/ai/run/${options.model}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
        body: JSON.stringify(buildCloudflareBody(options.model, options.request, useSchema)),
        signal: combinedSignal(options.signal),
      },
    );
  let useSchema = !cfNoSchema.has(options.model);
  let response = await post(useSchema);
  if (!response.ok) {
    const error = await errorFrom(response, "cloudflare");
    if (!useSchema || !schemaRejected(error)) throw error;
    cfNoSchema.add(options.model);
    useSchema = false;
    response = await post(false);
    if (!response.ok) throw await errorFrom(response, "cloudflare");
  }
  const payload = (await response.json()) as {
    success?: boolean;
    result?: CfResult | string;
    errors?: { message?: string; code?: number }[];
  };
  if (payload.success === false) {
    const message = payload.errors?.[0]?.message ?? "Cloudflare từ chối request.";
    throw new ProviderError(message, {
      status: /neuron|quota|limit/i.test(message) ? 429 : 502,
      lane: "cloudflare",
    });
  }
  const result = payload.result;
  let text = "";
  let finishReason = "stop";
  if (typeof result === "string") text = result;
  else if (result) {
    const choice = result.choices?.[0];
    if (choice?.message?.content) text = choice.message.content;
    else if (typeof result.response === "string") text = result.response;
    else if (result.response && typeof result.response === "object") text = JSON.stringify(result.response);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }
  const usage = typeof result === "object" ? result?.usage : undefined;
  const promptTokens = usage?.prompt_tokens ?? Math.max(1, Math.round((options.request.systemText.length + options.request.promptText.length) / 3.6));
  const outputTokens = usage?.completion_tokens ?? Math.max(1, Math.round(text.length / 4));
  return {
    text,
    finishReason,
    model: options.model,
    lane: "cloudflare",
    usage: { promptTokens, outputTokens, totalTokens: usage?.total_tokens ?? promptTokens + outputTokens },
    neurons: cfNeurons(options.model, promptTokens, outputTokens),
  };
}
