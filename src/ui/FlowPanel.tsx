import { useEffect, useState } from "react";
import { Download, ExternalLink, Image as ImageIcon, Pause, Play, RefreshCw, X } from "lucide-react";
import { formatElapsed } from "./useStudio.js";
import { imageUrl, type FlowHook } from "./useFlow.js";

export type FlowSceneInput = { sceneId: string; prompt: string; references: string[] };

const STATUS: Record<string, string> = {
  queued: "Đang xếp hàng",
  running: "Đang tạo ảnh",
  waiting: "Đang nghỉ giữa hai ảnh",
  paused: "Tạm dừng",
  done: "Xong",
  cancelled: "Đã dừng",
  interrupted: "Bị ngắt",
};

function Countdown({ at }: { at?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!at) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [at]);
  if (!at) return null;
  return <span> · ảnh kế tiếp sau {Math.max(0, Math.round((at - now) / 1000))} giây</span>;
}

export function FlowPanel({ flow, scenes, names, label, onClose }: { flow: FlowHook; scenes: FlowSceneInput[]; names: string[]; label: string; onClose: () => void }) {
  const status = flow.status;
  const summary = flow.summary;
  const [model, setModel] = useState("");
  const [gapMin, setGapMin] = useState(30);
  const [gapMax, setGapMax] = useState(45);
  const [link, setLink] = useState("");
  const [found, setFound] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    void flow.refreshStatus();
    void flow.refreshRefs();
    const timer = window.setInterval(() => void flow.refreshStatus(), 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!status) return;
    setModel((value) => value || status.config.model);
    setGapMin(status.config.gapMinSec);
    setGapMax(status.config.gapMaxSec);
  }, [status?.config.model, status?.config.gapMinSec, status?.config.gapMaxSec]); // eslint-disable-line react-hooks/exhaustive-deps

  const usedNames = names.filter((name) => scenes.some((scene) => scene.references.includes(name)));
  const pool = model === "nano-banana-pro" ? "pro" : "nb2";
  const quota = status?.quota[pool];
  const projectUrl = status?.config.projectUrl ?? "";
  const canRun = Boolean(status?.chrome !== false && !flow.busy);
  const job = flow.job;
  const localRef = (name: string) => flow.refs.find((item) => item.name.toLowerCase() === name.toLowerCase());
  const missingLocal = usedNames.filter((name) => !localRef(name));
  const signedOut = status?.browserOpen && status.signedIn === false;
  const flowLine = !status
    ? "Đang kiểm tra…"
    : !status.chrome
      ? "Không tìm thấy Google Chrome trên máy."
      : !status.browserOpen
        ? "Chưa mở — bấm Tạo ảnh là app tự mở Flow chạy ẩn (không hiện cửa sổ)."
        : status.signedIn
          ? status.window === "visible"
            ? "Đã đăng nhập. Khi tạo ảnh, app tự chuyển Flow sang chạy ẩn."
            : "Đã đăng nhập · Flow đang chạy ẩn trên máy này."
          : status.window === "visible"
            ? "Cửa sổ đăng nhập đang mở: đăng nhập Google trong đó, xong quay lại đây bấm Tạo ảnh."
            : "Chưa đăng nhập Google Flow.";

  return (
    <dialog open className="flow-panel" aria-label="Tạo ảnh bằng Google Flow">
      <div className="flow-head">
        <b><ImageIcon size={16} /> Tạo ảnh bằng Google Flow</b>
        <button type="button" aria-label="Đóng" onClick={onClose}><X size={16} /></button>
      </div>
      <p className="flow-warn">App tự điều khiển Flow bằng tài khoản Google của bạn (chạy ẩn, không cần mở Flow). Google không cho phép kiểu tự động này nên tài khoản có thể bị giới hạn hoặc khoá; bạn đã chọn chấp nhận rủi ro. App giãn cách mỗi ảnh, nghỉ 30 phút khi Flow báo tạo quá nhanh, và dừng hẳn khi hết lượt hoặc mất đăng nhập.</p>

      <div className="flow-steps">
        <div className={status?.signedIn ? "ok" : undefined}>
          <span>Google Flow: {flowLine}</span>
          {status?.signedIn && status.window !== "visible" ? null : (
            <button type="button" disabled={flow.busy || flow.running || status?.chrome === false} onClick={() => void flow.connect()}>{signedOut || status?.window === "visible" ? "Mở lại cửa sổ đăng nhập" : "Đăng nhập Google Flow (một lần)"}</button>
          )}
        </div>
        {usedNames.length ? (
          <div className={missingLocal.length ? undefined : "ok"} data-testid="flow-refs">
            <span>Ảnh nhân vật (app tự tải lên Flow nếu project còn thiếu){missingLocal.length ? ` — còn thiếu: ${missingLocal.join(", ")}` : ""}</span>
            <div className="flow-refs">
              {usedNames.map((name) => {
                const ref = localRef(name);
                return (
                  <label key={name} className={`flow-ref ${ref ? "ok" : "missing"}`}>
                    {ref ? <img src={`/api/flow/refs/${encodeURIComponent(ref.name)}?v=${flow.refsRev}`} alt={name} /> : <span className="flow-ref-empty">+</span>}
                    <b>{name}</b>
                    <small>{ref ? "Đổi ảnh" : "Chọn ảnh"}</small>
                    <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`Ảnh nhân vật ${name}`} disabled={flow.busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void flow.uploadRef(name, file); event.target.value = ""; }} />
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      <div className="flow-settings">
        <label>Mô hình
          <select value={model} onChange={(event) => { setModel(event.target.value); void flow.setConfig({ model: event.target.value }); }}>
            {(status?.models ?? []).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label>Nghỉ giữa hai ảnh (giây)
          <span className="flow-row">
            <input type="number" min={30} value={gapMin} onChange={(event) => setGapMin(Number(event.target.value))} onBlur={() => void flow.setConfig({ gapMinSec: gapMin, gapMaxSec: gapMax })} />
            –
            <input type="number" min={30} value={gapMax} onChange={(event) => setGapMax(Number(event.target.value))} onBlur={() => void flow.setConfig({ gapMinSec: gapMin, gapMaxSec: gapMax })} />
          </span>
        </label>
        {quota ? <small>App đã đếm {quota.used}/{quota.limit} ảnh trong 24 giờ{quota.resetAt ? ` (đặt lại lúc ${new Date(quota.resetAt).toLocaleString("vi-VN")})` : ""}. Số thật xem trong cài đặt Flow.</small> : null}
        <small>Ước tính chỉ để tham khảo [SUY RA]: {scenes.length} ảnh × ({gapMin}–{gapMax} giây nghỉ + thời gian Flow vẽ) ≈ {Math.round((scenes.length * gapMin) / 60)}–{Math.round((scenes.length * gapMax) / 60)} phút nghỉ, chưa tính thời gian vẽ.</small>
      </div>

      <details className="flow-advanced">
        <summary>Nâng cao: project Flow, kiểm tra ảnh nhân vật</summary>
        <p>App tự dùng project đã nhớ, nếu chưa có thì lấy project mới nhất trong Flow (hoặc tạo mới).</p>
        <div className="flow-row">
          <button type="button" disabled={flow.busy || !status?.browserOpen} onClick={() => void flow.useCurrent()}>Dùng project đang mở</button>
          <input placeholder="hoặc dán link https://flow.google.com/project/…" value={link} onChange={(event) => setLink(event.target.value)} />
          <button type="button" disabled={!link.trim() || flow.busy} onClick={() => void flow.setConfig({ projectUrl: link.trim() }).then(() => setLink(""))}>Lưu</button>
        </div>
        {projectUrl ? <small>Project: <a href={projectUrl} target="_blank" rel="noreferrer">{projectUrl.replace("https://", "")} <ExternalLink size={12} /></a></small> : null}
        <div className="flow-row">
          <button type="button" disabled={!projectUrl || !status?.signedIn || flow.busy || flow.running || !usedNames.length} onClick={() => void flow.checkRefs(usedNames).then((body) => body && setFound(body.found))}>Kiểm tra ảnh trong Flow</button>
          {found ? <small>{usedNames.map((name) => `${found[name] ? "✓" : "✗"} ${name}`).join("  ")}</small> : null}
        </div>
      </details>

      <div className="flow-actions">
        {flow.running ? (
          <button type="button" onClick={() => void flow.cancel()}><Pause size={14} /> Dừng</button>
        ) : (
          <button className="primary" type="button" disabled={!canRun || !scenes.length} onClick={() => void flow.start(label, model, scenes)}>
            <Play size={14} /> Tạo ảnh cho {scenes.length} cảnh
          </button>
        )}
        {summary && !flow.running && summary.pending > 0 ? <button type="button" disabled={!canRun} onClick={() => void flow.resume(false)}><Play size={14} /> Chạy tiếp ({summary.pending} cảnh)</button> : null}
        {summary && !flow.running && summary.failed > 0 ? <button type="button" disabled={!canRun} onClick={() => void flow.resume(true)}><RefreshCw size={14} /> Thử lại {summary.failed} cảnh lỗi</button> : null}
        {summary && summary.images > 0 ? <a className="button" href={`/api/flow/jobs/${summary.id}/zip`} download><Download size={14} /> Tải tất cả (zip)</a> : null}
      </div>
      {flow.error ? <p className="flow-error" role="alert">{flow.error}</p> : null}

      {summary ? (
        <div className="flow-progress" data-testid="flow-progress">
          <b>{STATUS[summary.status] ?? summary.status}</b> · {summary.done}/{summary.total} cảnh có ảnh{summary.failed ? ` · ${summary.failed} lỗi` : ""}{summary.skipped ? ` · ${summary.skipped} bỏ qua` : ""} · {formatElapsed(summary.elapsedMs)}
          {summary.current ? <span> · đang vẽ cảnh #{summary.current}</span> : null}
          {summary.status === "waiting" ? <Countdown at={summary.nextAt} /> : null}
          {summary.notice ? <p className="flow-note">{summary.notice}</p> : null}
          {summary.pauseReason ? <p className="flow-error">{summary.pauseReason}</p> : null}
          {flow.running ? <small>Có thể đóng tab hoặc tắt màn hình; việc tạo ảnh chạy ngầm trên máy tính này (máy phải bật).</small> : null}
        </div>
      ) : null}

      {job ? (
        <div className="flow-gallery">
          {job.scenes.map((scene) => (
            <figure key={scene.sceneId} className={`flow-card ${scene.status}`}>
              {scene.images[0] ? (
                <a href={imageUrl(job.id, scene.images[0].file)} target="_blank" rel="noreferrer"><img loading="lazy" src={imageUrl(job.id, scene.images[0].file)} alt={`Cảnh ${scene.sceneId}`} /></a>
              ) : (
                <div className="flow-empty">{scene.status === "running" ? "Đang vẽ…" : scene.status === "failed" ? "Lỗi" : scene.status === "skipped" ? "Bỏ qua" : "Chờ"}</div>
              )}
              <figcaption>
                <b>#{scene.sceneId}</b>
                {scene.images.map((image, index) => (
                  <a key={image.file} href={imageUrl(job.id, image.file, true)} download title={`${image.width ?? "?"}×${image.height ?? "?"}`}><Download size={12} />{scene.images.length > 1 ? index + 1 : ""}</a>
                ))}
                <button type="button" title="Tạo lại cảnh này" disabled={scene.status === "running" || flow.busy} onClick={() => void flow.regen(scene.sceneId)}><RefreshCw size={12} /></button>
                {scene.error && scene.status !== "done" ? <small title={scene.error}>{scene.error.slice(0, 80)}</small> : null}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}
    </dialog>
  );
}
