import { parseRetryAfter, ProviderError } from "../errors.js";
import type { GenerateRequest, GenerateResponse } from "../types.js";

function combinedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(120_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function errorFrom(response: Response, lane: string): Promise<ProviderError> {
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  let message = `${lane} HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } | string; message?: string };
    if (typeof body.error === "string") message = body.error;
    else if (body.error?.message) message = body.error.message;
    else if (body.message) message = body.message;
  } catch {
    /* giữ mã HTTP */
  }
  return new ProviderError(message.slice(0, 400), { status: response.status, lane, retryAfterMs });
}

export async function generateGroq(options: {
  apiKey: string;
  model: string;
  request: GenerateRequest;
  signal?: AbortSignal;
}): Promise<GenerateResponse> {
  if (!options.apiKey) throw new ProviderError("Thiếu Groq API key.", { status: 401, lane: "groq" });
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      temperature: options.request.temperature,
      max_tokens: options.request.maxOutputTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${options.request.systemText}\nReturn JSON.` },
        { role: "user", content: options.request.promptText },
      ],
    }),
    signal: combinedSignal(options.signal),
  });
  if (!response.ok) throw await errorFrom(response, "groq");
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

export async function generateCloudflare(options: {
  token: string;
  accountId: string;
  model: string;
  request: GenerateRequest;
  signal?: AbortSignal;
}): Promise<GenerateResponse> {
  if (!options.token || !options.accountId) {
    throw new ProviderError("Thiếu Cloudflare account hoặc token.", { status: 401, lane: "cloudflare" });
  }
  if (!/^[@A-Za-z0-9_./:-]+$/.test(options.model)) {
    throw new ProviderError("Tên model Cloudflare không hợp lệ.", { status: 400, lane: "cloudflare" });
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/ai/run/${options.model}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: `${options.request.systemText}\nReturn JSON.` },
          { role: "user", content: options.request.promptText },
        ],
        max_tokens: options.request.maxOutputTokens,
        temperature: options.request.temperature,
      }),
      signal: combinedSignal(options.signal),
    },
  );
  if (!response.ok) throw await errorFrom(response, "cloudflare");
  const payload = (await response.json()) as {
    success?: boolean;
    result?: { response?: string; choices?: { message?: { content?: string } }[] } | string;
    errors?: { message?: string }[];
  };
  if (payload.success === false) {
    throw new ProviderError(payload.errors?.[0]?.message ?? "Cloudflare từ chối request.", {
      status: 502,
      lane: "cloudflare",
    });
  }
  const result = payload.result;
  const text =
    typeof result === "string"
      ? result
      : result?.response ?? result?.choices?.[0]?.message?.content ?? "";
  const outputTokens = Math.max(1, Math.round(text.length / 4));
  const promptTokens = Math.max(1, Math.round(options.request.promptText.length / 4));
  return {
    text,
    finishReason: "stop",
    model: options.model,
    lane: "cloudflare",
    usage: { promptTokens, outputTokens, totalTokens: promptTokens + outputTokens },
  };
}
