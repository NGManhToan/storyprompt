import { parseRetryAfter, ProviderError } from "../errors.js";
import { buildGeminiBody } from "../prompts.js";
import type { GenerateRequest, GenerateResponse, ProviderLane } from "../types.js";

type GeminiPayload = {
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string }[] };
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { code?: number; message?: string; status?: string };
};

function combinedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(120_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readError(response: Response, lane: string): Promise<ProviderError> {
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  let message = `${lane} HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } | string; message?: string };
    if (typeof body.error === "string") message = body.error;
    else if (body.error?.message) message = body.error.message;
    else if (body.message) message = body.message;
  } catch {
    message = `${message} ${await response.text().catch(() => "")}`.trim();
  }
  return new ProviderError(message.slice(0, 400), { status: response.status, lane, retryAfterMs });
}

function isMissingModel(error: ProviderError): boolean {
  return error.status === 404 || /not found|not supported|unknown model|is not available/i.test(error.message);
}

export async function generateGeminiRest(options: {
  apiKey: string;
  models: string[];
  request: GenerateRequest;
  signal?: AbortSignal;
}): Promise<GenerateResponse> {
  const models = [...new Set(options.models.map((model) => model.trim()).filter(Boolean))];
  if (!options.apiKey) throw new ProviderError("Thiếu Gemini API key.", { status: 401, lane: "gemini" });
  if (!models.length) throw new ProviderError("Thiếu tên model Gemini.", { status: 400, lane: "gemini" });
  let last: ProviderError | null = null;
  for (const model of models) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": options.apiKey,
        },
        body: JSON.stringify(buildGeminiBody(options.request)),
        signal: combinedSignal(options.signal),
      },
    );
    if (!response.ok) {
      const error = await readError(response, "gemini");
      if (isMissingModel(error)) {
        last = error;
        continue;
      }
      throw error;
    }
    const payload = (await response.json()) as GeminiPayload;
    if (payload.error?.message) {
      throw new ProviderError(payload.error.message, { status: payload.error.code ?? 500, lane: "gemini" });
    }
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    const promptTokens = payload.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = payload.usageMetadata?.candidatesTokenCount ?? 0;
    return {
      text,
      finishReason: payload.candidates?.[0]?.finishReason ?? "STOP",
      model,
      lane: "gemini",
      usage: {
        promptTokens,
        outputTokens,
        totalTokens: payload.usageMetadata?.totalTokenCount ?? promptTokens + outputTokens,
      },
    };
  }
  throw last ?? new ProviderError("Không có model Gemini nào phản hồi.", { status: 404, lane: "gemini" });
}

export function geminiProvider(options: {
  apiKey: string;
  models: string[];
  signal?: AbortSignal;
}): { lane: ProviderLane; model: string; available: boolean; generate: (request: GenerateRequest, signal?: AbortSignal) => Promise<GenerateResponse> } {
  return {
    lane: "gemini",
    model: options.models[0] ?? "gemini-3.1-flash-lite",
    available: Boolean(options.apiKey && options.models.length),
    generate: (request, signal) => generateGeminiRest({ ...options, request, signal: signal ?? options.signal }),
  };
}
