import { netlifyResponse } from "../../src/server/api.js";

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}) {
  return netlifyResponse(event, "/api/test-key");
}
