import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const linuxChrome = "/usr/bin/google-chrome";
const winChrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const chrome = existsSync(linuxChrome) ? linuxChrome : existsSync(winChrome) ? winChrome : undefined;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:47221",
    permissions: ["clipboard-read", "clipboard-write"],
    launchOptions: chrome
      ? { executablePath: chrome, args: chrome === linuxChrome ? ["--no-sandbox", "--disable-dev-shm-usage"] : [] }
      : undefined,
  },
});
