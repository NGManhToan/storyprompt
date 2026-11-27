import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Nạp .env.local rồi .env (không cần dotenv). Không ghi đè biến đã có trong môi trường
 * và bỏ qua giá trị rỗng, nên khóa đặt sẵn trong biến môi trường Windows vẫn được giữ.
 * Không bao giờ in giá trị khóa.
 */
export function loadEnvFiles(root: string, names = [".env.local", ".env"]): string[] {
  const loaded: string[] = [];
  for (const name of names) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1];
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, "");
      }
      if (!value || process.env[key]) continue;
      process.env[key] = value;
    }
    loaded.push(name);
  }
  return loaded;
}
