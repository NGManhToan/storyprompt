import type { ProviderLane } from "./types.js";

/**
 * Hạn mức mặc định cho gói FREE. Nguồn ghi trong docs/FAST_FREE_PIPELINE.md.
 * - Groq: console.groq.com/docs/rate-limits (đọc 27/11/2026) — qwen/qwen3.8-27b 30 RPM, 1K RPD, 8K TPM.
 *   OTPM 1.000 đo từ header/429 thực tế (C# live-60), docs không công bố.
 * - Cloudflare: developers.cloudflare.com/workers-ai/platform/limits + pricing (27/11/2026) —
 *   10.000 neuron/ngày (reset 00:00 UTC), text-generation 300 RPM.
 * - Gemini: docs KHÔNG công bố số free RPM/TPM/RPD (chỉ hiện trong AI Studio). Số dưới là mức an toàn,
 *   CHƯA XÁC MINH; người dùng chỉnh theo trang rate-limit của AI Studio.
 */
export type LaneLimits = {
  rpm: number;
  tpm: number;
  rpd: number;
  otpm?: number;
  neuronStop?: number;
  tpmInputOnly?: boolean;
};

export const DEFAULT_LIMITS: Record<Exclude<ProviderLane, "mock">, LaneLimits> = {
  gemini: { rpm: 15, tpm: 250_000, rpd: 500, tpmInputOnly: true },
  groq: { rpm: 30, tpm: 8_000, rpd: 1_000, otpm: 1_000 },
  cloudflare: { rpm: 300, tpm: 1_000_000, rpd: 100_000, neuronStop: 9_000 },
};

/** Neuron trên 1 triệu token (input, output) theo bảng giá Workers AI, đọc 27/11/2026. */
export const CF_NEURONS_PER_M: Record<string, { input: number; output: number }> = {
  "@cf/qwen/qwen3.8-27b": { input: 40_909, output: 290_909 },
  "@cf/openai/gpt-oss-120b": { input: 31_818, output: 68_182 },
  "@cf/openai/gpt-oss-20b": { input: 18_182, output: 27_273 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { input: 26_668, output: 204_805 },
  "@cf/meta/llama-3.1-8b-instruct": { input: 25_608, output: 75_147 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { input: 4_625, output: 30_475 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { input: 24_545, output: 77_273 },
  "@cf/zai-org/glm-4.7-flash": { input: 5_500, output: 36_400 },
};

const CF_FALLBACK_PRICE = { input: 40_909, output: 290_909 };

export function cfNeurons(model: string, inputTokens: number, outputTokens: number): number {
  const price = CF_NEURONS_PER_M[model] ?? CF_FALLBACK_PRICE;
  return (Math.max(0, inputTokens) * price.input + Math.max(0, outputTokens) * price.output) / 1_000_000;
}

/** Ước lượng output cho một lô: ~180 token/hàng với schema 9 trường, cộng phong bì JSON. */
export const OUTPUT_TOKENS_PER_SCENE = 220;
export const OUTPUT_ENVELOPE = 96;

export function outputBudget(scenes: number, cap: number): number {
  return Math.min(Math.max(256, cap), Math.max(1, scenes) * OUTPUT_TOKENS_PER_SCENE + OUTPUT_ENVELOPE);
}

/** Output dự kiến (không phải trần) để xếp hàng theo OTPM: ~126 token/hàng [ĐO: Groq qwen3.8-27b, 46 hàng, 5.785 token]. */
export function expectedOutput(scenes: number): number {
  return Math.max(1, scenes) * 135 + 40;
}
