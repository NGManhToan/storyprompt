import { useState } from "react";
import {
  KEY_PROVIDERS,
  keyDisplayName,
  keysOf,
  maskKey,
  newKeyId,
  PROVIDER_NAMES,
  validateNewKey,
  type KeyProvider,
  type StoredKey,
} from "../core/keys.js";
import type { ServerHealth } from "./lanes.js";
import type { Settings } from "./storage.js";

type TestState = { busy?: boolean; ok?: boolean; message?: string };

async function callTest(provider: KeyProvider, key: string, account: string): Promise<TestState> {
  try {
    const response = await fetch("/api/test-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, key, account }),
    });
    const body = (await response.json()) as { ok?: boolean; message?: string; models?: number };
    if (!response.ok) return { ok: false, message: body.message || `Server HTTP ${response.status}` };
    return { ok: Boolean(body.ok), message: body.ok && body.models !== undefined ? `${body.message} (${body.models} model)` : body.message };
  } catch {
    return { ok: false, message: "Không gọi được server cục bộ." };
  }
}

export function KeyManager({ settings, set, health }: { settings: Settings; set: (next: Settings) => void; health: ServerHealth | null }) {
  const [adding, setAdding] = useState<KeyProvider | null>(null);
  const [draft, setDraft] = useState({ label: "", key: "", account: "" });
  const [error, setError] = useState("");
  const [tests, setTests] = useState<Record<string, TestState>>({});

  function patchKey(id: string, patch: Partial<StoredKey>) {
    set({ ...settings, keys: settings.keys.map((item) => (item.id === id ? { ...item, ...patch } : item)) });
  }

  function removeKey(id: string) {
    set({ ...settings, keys: settings.keys.filter((item) => item.id !== id) });
  }

  function startAdd(provider: KeyProvider) {
    const lastAccount = keysOf(settings.keys, "cloudflare").find((item) => item.account)?.account ?? "";
    setDraft({ label: "", key: "", account: provider === "cloudflare" ? lastAccount : "" });
    setError("");
    setAdding(provider);
  }

  function commitAdd(provider: KeyProvider) {
    const problem = validateNewKey({ provider, key: draft.key, account: draft.account }, settings.keys);
    if (problem) {
      setError(problem);
      return;
    }
    const item: StoredKey = {
      id: newKeyId(),
      provider,
      label: draft.label.trim(),
      key: draft.key.trim(),
      enabled: true,
      ...(provider === "cloudflare" ? { account: draft.account.trim() } : {}),
    };
    set({ ...settings, keys: [...settings.keys, item] });
    setAdding(null);
    setDraft({ label: "", key: "", account: "" });
  }

  async function test(id: string, provider: KeyProvider, key: string, account: string) {
    setTests((current) => ({ ...current, [id]: { busy: true } }));
    const result = await callTest(provider, key, account);
    setTests((current) => ({ ...current, [id]: result }));
  }

  function toggleServer(provider: KeyProvider, enabled: boolean) {
    const rest = settings.serverOff.filter((item) => item !== provider);
    set({ ...settings, serverOff: enabled ? rest : [...rest, provider] });
  }

  function result(id: string) {
    const state = tests[id];
    if (!state) return null;
    if (state.busy) return <small className="key-result">Đang kiểm tra…</small>;
    return <small className={`key-result ${state.ok ? "ok" : "bad"}`} role="status">{state.ok ? "✓" : "✗"} {state.message}</small>;
  }

  return (
    <section className="keys" aria-labelledby="keys-title">
      <h3 id="keys-title">Khóa API</h3>
      <p>Mỗi key là một lane riêng: hết lượt hoặc bị 429 thì app chuyển sang key kế tiếp. Key bạn thêm ở đây chỉ nằm trong localStorage của trình duyệt này.</p>
      {KEY_PROVIDERS.map((provider) => {
        const own = keysOf(settings.keys, provider);
        const serverHas = Boolean(health?.[provider]);
        return (
          <div className="key-group" key={provider}>
            <div className="key-group-head">
              <b>{PROVIDER_NAMES[provider]}</b>
              <button type="button" onClick={() => startAdd(provider)} disabled={adding === provider}>＋ Thêm key mới</button>
            </div>
            {serverHas && (
              <div className="key-row" data-testid={`key-server-${provider}`}>
                <label className="switch">
                  <input type="checkbox" checked={!settings.serverOff.includes(provider)} onChange={(event) => toggleServer(provider, event.target.checked)} aria-label={`Bật khóa server ${PROVIDER_NAMES[provider]}`} />
                  <span>Từ server (.env)</span>
                </label>
                <code>{health?.hints?.[provider] ? `…${health.hints[provider]!.replace(/^…/, "")}` : "••••"}</code>
                <span className="tag">chỉ đọc</span>
                <button type="button" onClick={() => void test(`server-${provider}`, provider, "", "")}>Kiểm tra</button>
                {result(`server-${provider}`)}
              </div>
            )}
            {own.map((item, index) => (
              <div className="key-row" key={item.id} data-testid={`key-${item.id}`}>
                <label className="switch">
                  <input type="checkbox" checked={item.enabled} onChange={(event) => patchKey(item.id, { enabled: event.target.checked })} aria-label={`Bật ${keyDisplayName(item, index)}`} />
                  <input
                    className="key-label"
                    value={item.label}
                    placeholder={keyDisplayName({ ...item, label: "" }, index)}
                    onChange={(event) => patchKey(item.id, { label: event.target.value })}
                    aria-label="Nhãn"
                  />
                </label>
                <code>{maskKey(item.key)}</code>
                {provider === "cloudflare" && <small>Account {item.account ? `${item.account.slice(0, 4)}…${item.account.slice(-4)}` : "(thiếu)"}</small>}
                <button type="button" onClick={() => void test(item.id, provider, item.key, item.account ?? "")}>Kiểm tra</button>
                <button type="button" onClick={() => removeKey(item.id)} aria-label={`Xoá ${keyDisplayName(item, index)}`}>Xoá</button>
                {result(item.id)}
              </div>
            ))}
            {!serverHas && !own.length && <small>Chưa có key. Bấm “Thêm key mới”.</small>}
            {adding === provider && (
              <form
                className="key-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  commitAdd(provider);
                }}
              >
                <label>Nhãn (tuỳ chọn)<input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="vd. Gmail phụ" /></label>
                <label>{provider === "cloudflare" ? "API token" : "API key"}<input type="password" autoComplete="off" value={draft.key} onChange={(event) => setDraft({ ...draft, key: event.target.value })} /></label>
                {provider === "cloudflare" && (
                  <label>Account ID<input value={draft.account} onChange={(event) => setDraft({ ...draft, account: event.target.value })} autoComplete="off" /></label>
                )}
                {error && <small className="key-result bad" role="alert">{error}</small>}
                <div className="key-actions">
                  <button type="submit" className="primary">Lưu key</button>
                  <button type="button" onClick={() => void test("draft", provider, draft.key, draft.account)} disabled={!draft.key.trim()}>Kiểm tra trước</button>
                  <button type="button" onClick={() => setAdding(null)}>Huỷ</button>
                </div>
                {result("draft")}
              </form>
            )}
          </div>
        );
      })}
    </section>
  );
}
