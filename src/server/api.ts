import { ProviderError } from "../core/errors.js";
import { generateGeminiRest } from "../core/providers/gemini.js";
import { generateCloudflare, generateGroq } from "../core/providers/httpLanes.js";
import type { GenerateRequest, GenerateResponse } from "../core/types.js";
import { geminiWithSdk } from "./geminiSdk.js";

const cors: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-gemini-key, x-groq-key, x-cf-token, x-cf-account",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", ...cors });
  if (extra) new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(body), { status, headers });
}

function safe(message: string) {
  return message.replace(/key=[^&\s]+/gi, "key=***").slice(0, 400);
}

function header(request: Request, name: string): string {
  return request.headers.get(name)?.trim() || "";
}

function missingModel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  const status = error instanceof ProviderError ? error.status : 0;
  return status === 404 || /not found|not supported|unknown model|is not available/i.test(message);
}

async function runGemini(apiKey: string, models: string[], request: GenerateRequest): Promise<GenerateResponse> {
  let last: unknown;
  let preferRest = false;
  for (const model of models) {
    if (!preferRest) {
      try {
        return await geminiWithSdk(apiKey, model, request);
      } catch (error) {
        last = error;
        if (error instanceof ProviderError && (error.status === 401 || error.status === 403 || error.status === 429)) throw error;
        if (missingModel(error)) continue;
        preferRest = true;
      }
    }
    try {
      return await generateGeminiRest({ apiKey, models: [model], request });
    } catch (error) {
      last = error;
      if (error instanceof ProviderError && (error.status === 401 || error.status === 403 || error.status === 429)) throw error;
      if (missingModel(error)) continue;
      throw error;
    }
  }
  throw last instanceof Error ? last : new ProviderError("Gemini không phản hồi.", { status: 502, lane: "gemini" });
}

export async function handleApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method === "GET" && (path.endsWith("/health") || path === "/api/health")) {
    return json({
      ok: true,
      gemini: Boolean(process.env.GEMINI_API_KEY),
      groq: Boolean(process.env.GROQ_API_KEY),
      cloudflare: Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID),
    });
  }
  if (request.method === "POST" && (path.endsWith("/generate") || path === "/api/generate")) {
    try {
      const body = (await request.json()) as {
        lane?: "gemini" | "groq" | "cloudflare";
        models?: string[];
        groqModel?: string;
        cfModel?: string;
        request?: GenerateRequest;
      };
      if (!body.request) return json({ error: "Thiếu request." }, 400);
      const lane = body.lane ?? "gemini";
      const geminiKey = header(request, "x-gemini-key") || process.env.GEMINI_API_KEY || "";
      const groqKey = header(request, "x-groq-key") || process.env.GROQ_API_KEY || "";
      const cfToken = header(request, "x-cf-token") || process.env.CLOUDFLARE_API_TOKEN || "";
      const cfAccount = header(request, "x-cf-account") || process.env.CLOUDFLARE_ACCOUNT_ID || "";
      const models = (body.models?.length ? body.models : ["gemini-3.1-flash-lite", "gemini-3.8-flash", "gemini-flash-latest"])
        .map((model) => model.trim())
        .filter(Boolean);
      let result: GenerateResponse;
      if (lane === "groq") result = await generateGroq({ apiKey: groqKey, model: body.groqModel || "llama-3.3-70b-versatile", request: body.request });
      else if (lane === "cloudflare") {
        result = await generateCloudflare({
          token: cfToken,
          accountId: cfAccount,
          model: body.cfModel || "@cf/meta/llama-3.1-8b-instruct",
          request: body.request,
        });
      } else result = await runGemini(geminiKey, models, body.request);
      return json(result);
    } catch (error) {
      if (error instanceof ProviderError) {
        const headers = error.retryAfterMs ? { "retry-after": String(Math.ceil(error.retryAfterMs / 1000)) } : undefined;
        return json({ error: safe(error.message) }, error.status || 502, headers);
      }
      return json({ error: safe(error instanceof Error ? error.message : "Lỗi server.") }, 502);
    }
  }
  return json({ error: "Không có route." }, 404);
}

type NetlifyEvent = {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
};

export async function netlifyResponse(event: NetlifyEvent, route: "/api/health" | "/api/generate") {
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) {
    if (value) headers.set(key, value);
  }
  const request = new Request(`https://storyprompt.local${route}`, {
    method: event.httpMethod,
    headers,
    body: event.httpMethod === "GET" || event.httpMethod === "HEAD" ? undefined : event.body ?? undefined,
  });
  const response = await handleApi(request);
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
}
