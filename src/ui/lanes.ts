import { ProviderError, parseRetryAfter } from "../core/errors.js";
import { geminiProvider } from "../core/providers/gemini.js";
import { createMockProvider } from "../core/providers/mock.js";
import type { GenerateRequest, GenerateResponse, Provider } from "../core/types.js";
import type { Settings } from "./storage.js";

export type ServerHealth = {
  ok: boolean;
  gemini: boolean;
  groq: boolean;
  cloudflare: boolean;
};

function modelsOf(settings: Settings): string[] {
  return [settings.geminiModel, ...settings.geminiFallbacks.split(",")]
    .map((item) => item.trim())
    .filter(Boolean);
}

async function postGenerate(settings: Settings, lane: Settings["lane"], request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
  const response = await fetch("/api/generate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gemini-key": settings.geminiKey,
      "x-groq-key": settings.groqKey,
      "x-cf-token": settings.cfToken,
      "x-cf-account": settings.cfAccount,
    },
    body: JSON.stringify({
      lane,
      models: modelsOf(settings),
      groqModel: settings.groqModel,
      cfModel: settings.cfModel,
      request,
    }),
    signal,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ProviderError(payload.error || `Proxy HTTP ${response.status}`, {
      status: response.status,
      lane,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    });
  }
  return (await response.json()) as GenerateResponse;
}

function proxyProvider(settings: Settings, lane: Settings["lane"], health: ServerHealth | null): Provider {
  const model = lane === "groq" ? settings.groqModel : lane === "cloudflare" ? settings.cfModel : modelsOf(settings)[0];
  const available =
    lane === "gemini"
      ? Boolean(settings.geminiKey || health?.gemini)
      : lane === "groq"
        ? Boolean(settings.groqKey || health?.groq)
        : Boolean((settings.cfAccount && settings.cfToken) || health?.cloudflare);
  return {
    lane,
    model,
    available,
    generate: (request, signal) => postGenerate(settings, lane, request, signal),
  };
}

export function buildLanes(settings: Settings, health: ServerHealth | null, mode: "mock" | "live"): Provider[] {
  if (mode === "mock") {
    return [createMockProvider({ delayMs: 220, fail: { "003": "language", "005": "omit" } })];
  }
  const proxy = {
    gemini: proxyProvider(settings, "gemini", health),
    groq: proxyProvider(settings, "groq", health),
    cloudflare: proxyProvider(settings, "cloudflare", health),
  };
  const direct =
    settings.lane === "gemini" && settings.directBrowser && settings.geminiKey
      ? geminiProvider({ apiKey: settings.geminiKey, models: modelsOf(settings) })
      : null;
  const gemini: Provider = direct
    ? {
        ...direct,
        async generate(request, signal) {
          try {
            return await direct.generate(request, signal);
          } catch (error) {
            if (error instanceof ProviderError || !proxy.gemini.available) throw error;
            return proxy.gemini.generate(request, signal);
          }
        },
      }
    : proxy.gemini;

  const selected = { gemini, groq: proxy.groq, cloudflare: proxy.cloudflare };
  const order = [settings.lane, "gemini", "groq", "cloudflare"] as const;
  const seen = new Set<string>();
  return order
    .filter((lane) => {
      if (seen.has(lane)) return false;
      seen.add(lane);
      return selected[lane].available;
    })
    .map((lane) => selected[lane]);
}
