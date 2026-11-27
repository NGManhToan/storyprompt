import { ProviderError } from "../core/errors.js";
import { DEFAULT_LIMITS } from "../core/laneLimits.js";
import { ACTIVE_GEMINI_MODELS, generateGeminiRest, resolveGeminiModels } from "../core/providers/gemini.js";
import { generateCloudflare, generateGroq } from "../core/providers/httpLanes.js";
import type { GenerateRequest, GenerateResponse } from "../core/types.js";

export const DEFAULT_GROQ_MODEL = "qwen/qwen3.8-27b";
export const DEFAULT_CF_MODEL = "@cf/qwen/qwen3.8-27b";

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
      models: { gemini: ACTIVE_GEMINI_MODELS, groq: DEFAULT_GROQ_MODEL, cloudflare: DEFAULT_CF_MODEL },
      limits: DEFAULT_LIMITS,
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
      const models = resolveGeminiModels(body.models ?? []);
      let result: GenerateResponse;
      if (lane === "groq") result = await generateGroq({ apiKey: groqKey, model: body.groqModel || DEFAULT_GROQ_MODEL, request: body.request });
      else if (lane === "cloudflare") {
        result = await generateCloudflare({
          token: cfToken,
          accountId: cfAccount,
          model: body.cfModel || DEFAULT_CF_MODEL,
          request: body.request,
        });
      } else result = await generateGeminiRest({ apiKey: geminiKey, models, request: body.request });
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
