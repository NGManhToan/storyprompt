import { GoogleGenAI } from "@google/genai";
import { ProviderError } from "../core/errors.js";
import type { GenerateRequest, GenerateResponse } from "../core/types.js";

export async function geminiWithSdk(
  apiKey: string,
  model: string,
  request: GenerateRequest,
  signal?: AbortSignal,
): Promise<GenerateResponse> {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: request.promptText,
    config: {
      systemInstruction: request.systemText,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      responseMimeType: "application/json",
      responseJsonSchema: request.responseSchema,
      abortSignal: signal,
    },
  });
  const text = response.text ?? "";
  if (!text && response.promptFeedback?.blockReason) {
    throw new ProviderError(`Gemini chặn prompt: ${response.promptFeedback.blockReason}`, {
      status: 400,
      lane: "gemini",
    });
  }
  const promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
  return {
    text,
    finishReason: String(response.candidates?.[0]?.finishReason ?? "STOP"),
    model: response.modelVersion ?? model,
    lane: "gemini",
    usage: {
      promptTokens,
      outputTokens,
      totalTokens: response.usageMetadata?.totalTokenCount ?? promptTokens + outputTokens,
    },
  };
}
