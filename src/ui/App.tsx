import { useEffect, useMemo, useState } from "react";
import { countWords } from "../core/types.js";
import type { SceneResult } from "../core/types.js";
import { wrapPrompt } from "../core/export.js";
import { useStudio } from "./useStudio.js";

const STATUS_LABEL: Record<string, string> = {
  pending: "Chờ",
  running: "Đang viết",
  accepted: "Đạt",
  rejected: "Bị loại",
  missing: "Thiếu",
  edited: "Đã sửa",
  failed: "Chưa xong",
};

function formatMs(ms: number) {
  const safe = Math.max(0, ms);
  if (safe < 10_000) return `${(safe / 1000).toFixed(1)} giây`;
  const seconds = Math.round(safe / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatTokens(value: number) {
  return new Intl.NumberFormat("vi-VN").format(value);
}

export function App() {
  const studio = useStudio();
  const [pane, setPane] = useState<"scenes" | "file">("scenes");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const usable = studio.results.some((row) => row.prompt && (row.status === "accepted" || row.status === "edited"));
  const continueRun = studio.results.some((row) => row.status === "accepted" || row.status === "edited");
  const selected = studio.scenes.find((scene) => scene.sceneId === selectedId) ?? studio.scenes[0];
  const selectedResult = studio.results.find((row) => row.sceneId === selected?.sceneId);

  useEffect(() => {
    if (!studio.scenes.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !studio.scenes.some((scene) => scene.sceneId === selectedId)) {
      setSelectedId(studio.scenes[0].sceneId);
    }
  }, [studio.scenes, selectedId]);

  const counts = useMemo(() => {
    const all = studio.scenes.length;
    const accepted = studio.results.filter((row) => row.status === "accepted" || row.status === "edited").length;
    const attention = studio.results.filter((row) => row.status === "failed" || row.status === "rejected" || row.status === "missing").length;
    const waiting = all - accepted - attention;
    return { all, accepted, attention, waiting };
  }, [studio.scenes.length, studio.results]);

  const visibleScenes = studio.scenes.filter((scene) => {
    const row = studio.results.find((item) => item.sceneId === scene.sceneId);
    if (studio.filter === "accepted" && row?.status !== "accepted" && row?.status !== "edited") return false;
    if (studio.filter === "attention" && row?.status !== "failed" && row?.status !== "rejected" && row?.status !== "missing") return false;
    if (!query.trim()) return true;
    const haystack = `${scene.sceneId} ${scene.title} ${scene.source} ${row?.prompt ?? ""}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  const progress = studio.scenes.length ? Math.round((studio.doneCount / studio.scenes.length) * 100) : 0;

  return (
    <div className="workspace">
      <header className="bar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <strong>StoryPrompt</strong>
            <small>{studio.fileName || "Chưa có file"}</small>
          </div>
        </div>
        {studio.scenes.length ? (
          <div className="bar-progress" title={studio.label}>
            <span>
              {studio.doneCount}/{studio.scenes.length}
            </span>
            <i>
              <b style={{ width: `${progress}%` }} />
            </i>
            <span>{studio.phase === "running" ? formatMs(studio.elapsed) : studio.report ? formatMs(studio.report.wallTimeMs) : studio.label}</span>
          </div>
        ) : (
          <p className="bar-note">Một cảnh, một prompt tiếng Anh cho Google Flow.</p>
        )}
        <div className="bar-actions">
          {studio.phase === "running" ? (
            <button className="btn danger" type="button" onClick={studio.stop}>
              Dừng
            </button>
          ) : (
            <>
              <button className="btn" type="button" disabled={!studio.scenes.length} onClick={() => void studio.run("mock", { fresh: !continueRun })}>
                {continueRun ? "Mô phỏng tiếp" : "Mô phỏng"}
              </button>
              <button className="btn primary" type="button" disabled={!studio.scenes.length} onClick={() => void studio.run("live", { fresh: !continueRun })}>
                {continueRun ? "Chạy tiếp" : "Chạy"}
              </button>
            </>
          )}
          <div className="menu">
            <button className="btn" type="button" disabled={!usable} onClick={() => setExportOpen((open) => !open)}>
              Xuất
            </button>
            {exportOpen && usable ? (
              <div className="menu-pop">
                <button type="button" onClick={() => { void studio.copyAll(); setExportOpen(false); }}>Sao chép</button>
                <button type="button" onClick={() => { studio.download("numbered"); setExportOpen(false); }}>TXT số</button>
                <button type="button" onClick={() => { studio.download("txt"); setExportOpen(false); }}>TXT</button>
                <button type="button" onClick={() => { studio.download("flow"); setExportOpen(false); }}>Gói Flow</button>
                <button type="button" onClick={() => { studio.download("json"); setExportOpen(false); }}>JSON</button>
                <button type="button" onClick={() => { studio.download("csv"); setExportOpen(false); }}>CSV</button>
                {continueRun ? (
                  <button type="button" onClick={() => { setExportOpen(false); void studio.run("live", { fresh: true }); }}>
                    Viết lại tất cả
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <button className="icon-btn" type="button" onClick={() => studio.setGuideOpen(true)} aria-label="Hướng dẫn">?</button>
          <button className="icon-btn" type="button" onClick={() => studio.setSettingsOpen(true)} aria-label="Cài đặt">
            <GearIcon />
          </button>
          <button className="icon-btn" type="button" onClick={() => studio.setTheme(studio.theme === "dark" ? "light" : "dark")} aria-label={studio.theme === "dark" ? "Giao diện sáng" : "Giao diện tối"}>
            <ThemeIcon dark={studio.theme === "dark"} />
          </button>
        </div>
      </header>

      {studio.error ? <p className="banner bad">{studio.error}</p> : null}
      {studio.resumeOffer ? (
        <div className="banner">
          <p>
            Có bản lưu {new Date(studio.resumeOffer.savedAt).toLocaleString("vi-VN")},{" "}
            {studio.resumeOffer.results.filter((row) => row.status === "accepted" || row.status === "edited").length} cảnh đã xong.
          </p>
          <div className="row">
            <button className="btn small" type="button" onClick={() => studio.applyCheckpoint(studio.resumeOffer!)}>Tiếp tục</button>
            <button className="btn ghost small" type="button" onClick={studio.dismissResume}>Bỏ</button>
          </div>
        </div>
      ) : null}

      <div className="desk">
        <aside className="rail">
          <div className="rail-tabs">
            <button type="button" className={pane === "scenes" ? "on" : ""} onClick={() => setPane("scenes")}>Cảnh</button>
            <button type="button" className={pane === "file" ? "on" : ""} onClick={() => setPane("file")}>Tệp</button>
          </div>
          {pane === "scenes" ? (
            <>
              <input className="search" value={query} placeholder="Tìm cảnh hoặc prompt" aria-label="Tìm cảnh" onChange={(event) => setQuery(event.target.value)} />
              <div className="filters">
                <button type="button" className={studio.filter === "all" ? "pill on" : "pill"} onClick={() => studio.setFilter("all")}>Tất cả {counts.all}</button>
                <button type="button" className={studio.filter === "accepted" ? "pill on" : "pill"} onClick={() => studio.setFilter("accepted")}>Đạt {counts.accepted}</button>
                <button type="button" className={studio.filter === "attention" ? "pill on" : "pill"} onClick={() => studio.setFilter("attention")}>Cần xem {counts.attention}</button>
              </div>
              <div className="scene-list">
                {visibleScenes.map((scene) => {
                  const row = studio.results.find((item) => item.sceneId === scene.sceneId);
                  const active = scene.sceneId === selected?.sceneId;
                  return (
                    <button key={scene.sceneId} type="button" className={active ? "scene-item on" : "scene-item"} onClick={() => setSelectedId(scene.sceneId)}>
                      <span className={`dot ${row?.status ?? "pending"}`} />
                      <span className="scene-item-id">{scene.sceneId}</span>
                      <span className="scene-item-text">{scene.timeRange || oneLine(scene.source)}</span>
                      <span className="scene-item-status">{STATUS_LABEL[row?.status ?? "pending"]}</span>
                    </button>
                  );
                })}
                {!visibleScenes.length ? <p className="hint">Không có cảnh khớp.</p> : null}
              </div>
            </>
          ) : (
            <FilePane studio={studio} dragOver={dragOver} setDragOver={setDragOver} />
          )}
        </aside>

        <main className="stage">
          {!selected ? (
            <EmptyDrop studio={studio} dragOver={dragOver} setDragOver={setDragOver} />
          ) : (
            <SceneStage
              studio={studio}
              sceneId={selected.sceneId}
              title={selected.title}
              source={selected.source}
              timeRange={selected.timeRange}
              cutReason={selected.cutReason}
              result={selectedResult}
            />
          )}
        </main>
      </div>

      <footer className={reportOpen ? "report-bar open" : "report-bar"}>
        <button type="button" className="report-toggle" onClick={() => setReportOpen((open) => !open)}>
          <span>Báo cáo{studio.lastMode === "mock" && studio.report ? " mô phỏng" : ""}</span>
          <strong>{studio.report ? `${studio.report.acceptedPct}% đạt` : "Chưa chạy"}</strong>
          <span>{studio.report ? `${formatMs(studio.report.wallTimeMs)} · ${studio.report.requests} request · ${formatTokens(studio.report.tokens.total)} token` : "Số đo hiện sau khi chạy"}</span>
        </button>
        {reportOpen && studio.report ? <ReportBody report={studio.report} logs={studio.logs} mock={studio.lastMode === "mock"} /> : null}
      </footer>

      {studio.toast ? <div className="toast">{studio.toast}</div> : null}
      {studio.guideOpen ? <Guide onClose={() => studio.setGuideOpen(false)} /> : null}
      {studio.settingsOpen ? <SettingsDrawer studio={studio} onClose={() => studio.setSettingsOpen(false)} /> : null}
    </div>
  );
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 72);
}

function FilePane({
  studio,
  dragOver,
  setDragOver,
}: {
  studio: ReturnType<typeof useStudio>;
  dragOver: boolean;
  setDragOver: (value: boolean) => void;
}) {
  const [name, setName] = useState("");
  return (
    <div className="file-pane">
      <DropBox studio={studio} dragOver={dragOver} setDragOver={setDragOver} compact />
      <button className="btn ghost wide" type="button" onClick={() => void studio.loadSample()}>File mẫu 20 cảnh</button>
      {studio.warnings.map((warning) => <p key={warning} className="hint">{warning}</p>)}
      <div className="filters">
        {(
          [
            ["headings", "Theo cảnh"],
            ["fixed", `${studio.duration}s`],
            ["sense", "Cụm nghĩa"],
          ] as const
        ).map(([mode, text]) => (
          <button key={mode} type="button" className={studio.chunkMode === mode ? "pill on" : "pill"} onClick={() => studio.recut(mode, studio.duration)}>
            {text}
          </button>
        ))}
      </div>
      <label>
        Nhịp
        <select value={studio.duration} onChange={(event) => studio.recut(studio.chunkMode === "headings" ? "fixed" : studio.chunkMode, Number(event.target.value))}>
          {[4, 6, 8, 10, 12].map((seconds) => <option key={seconds} value={seconds}>{seconds} giây</option>)}
        </select>
      </label>
      <label>
        Kịch bản gốc
        <textarea rows={4} value={studio.masterScript} placeholder="Tuỳ chọn. Giữ không gian cho cả phim." onChange={(event) => studio.setMasterScript(event.target.value)} />
      </label>
      <label>
        Chủ đề
        <input value={studio.settings.topic} onChange={(event) => studio.setSettings({ ...studio.settings, topic: event.target.value })} />
      </label>
      <label>
        Người kể
        <input value={studio.settings.protagonist} placeholder="Để trống nếu không có" onChange={(event) => studio.setSettings({ ...studio.settings, protagonist: event.target.value })} />
      </label>
      <div className="chips">
        {studio.knownNames.map((item) => (
          <button key={item} type="button" className="chip" onClick={() => studio.removeName(item)}>{item} ×</button>
        ))}
      </div>
      <form className="add-name" onSubmit={(event) => { event.preventDefault(); studio.addName(name); setName(""); }}>
        <input value={name} placeholder="Thêm tên" aria-label="Thêm tên nhân vật" onChange={(event) => setName(event.target.value)} />
        <button className="btn small" type="submit">Thêm</button>
      </form>
    </div>
  );
}

function DropBox({
  studio,
  dragOver,
  setDragOver,
  compact,
}: {
  studio: ReturnType<typeof useStudio>;
  dragOver: boolean;
  setDragOver: (value: boolean) => void;
  compact?: boolean;
}) {
  return (
    <label
      className={dragOver ? "drop over" : "drop"}
      onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void studio.onFile(file);
      }}
    >
      <input type="file" accept=".srt,.txt,text/plain" onChange={(event) => { const file = event.target.files?.[0]; if (file) void studio.onFile(file); }} />
      <span className="drop-title">{studio.fileName || "Thả file .srt hoặc .txt"}</span>
      {compact ? null : <span className="drop-copy">Phụ đề thoại cắt theo 8 giây. File có tiêu đề cảnh thì giữ từng cảnh.</span>}
    </label>
  );
}

function EmptyDrop({
  studio,
  dragOver,
  setDragOver,
}: {
  studio: ReturnType<typeof useStudio>;
  dragOver: boolean;
  setDragOver: (value: boolean) => void;
}) {
  return (
    <section className="empty">
      <p className="eyebrow">SRT → prompt</p>
      <h1>Chọn một cảnh, xem lời thoại, sửa prompt.</h1>
      <DropBox studio={studio} dragOver={dragOver} setDragOver={setDragOver} />
      <button className="btn primary" type="button" onClick={() => void studio.loadSample()}>Mở file mẫu</button>
    </section>
  );
}

function SceneStage({
  studio,
  sceneId,
  title,
  source,
  timeRange,
  cutReason,
  result,
}: {
  studio: ReturnType<typeof useStudio>;
  sceneId: string;
  title: string;
  source: string;
  timeRange?: string;
  cutReason?: string;
  result?: SceneResult;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title, environment: "", prompt: "", cast: "" });
  useEffect(() => {
    setEditing(false);
    setDraft({
      title: result?.title || title,
      environment: result?.environment || "",
      prompt: result?.prompt || "",
      cast: result?.visibleCast.join(", ") || "",
    });
  }, [sceneId, result?.title, result?.environment, result?.prompt, result?.visibleCast, title]);

  const shown = result?.prompt ? wrapPrompt(result.prompt, studio.settings.prefix, studio.settings.footer) : "";

  return (
    <section className="stage-card">
      <header className="stage-head">
        <div>
          <p className="eyebrow">{timeRange || cutReason || "Cảnh"}</p>
          <h2>#{sceneId} {result?.title || title}</h2>
        </div>
        <span className={`status ${result?.status ?? "pending"}`}>{STATUS_LABEL[result?.status ?? "pending"]}</span>
      </header>
      <div className="stage-grid">
        <article>
          <h3>Lời thoại</h3>
          <p className="source-block">{source}</p>
        </article>
        <article>
          <div className="row-between">
            <h3>Prompt</h3>
            <span className="meta">{result?.prompt ? `${countWords(result.prompt)} từ` : ""}</span>
          </div>
          {editing ? (
            <form className="edit" onSubmit={(event) => { event.preventDefault(); studio.saveEdit(sceneId, draft); setEditing(false); }}>
              <input value={draft.title} aria-label="Tiêu đề" onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
              <input value={draft.environment} aria-label="Bối cảnh" placeholder="Bối cảnh" onChange={(event) => setDraft({ ...draft, environment: event.target.value })} />
              <textarea rows={8} value={draft.prompt} aria-label="Prompt" onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} />
              <input value={draft.cast} aria-label="Diễn viên" placeholder="Tên, cách nhau bởi dấu phẩy" onChange={(event) => setDraft({ ...draft, cast: event.target.value })} />
              <div className="row">
                <button className="btn small" type="submit">Lưu</button>
                <button className="btn ghost small" type="button" onClick={() => setEditing(false)}>Hủy</button>
                <span className="meta">{countWords(draft.prompt)} từ</span>
              </div>
            </form>
          ) : (
            <p className={shown ? "prompt-block" : "prompt-block empty"}>{shown || "Chưa có prompt."}</p>
          )}
          {result?.rejections.length ? (
            <ul className="reasons">
              {result.rejections.map((reason) => <li key={reason.code}>{reason.detail}</li>)}
            </ul>
          ) : null}
        </article>
      </div>
      <footer className="stage-foot">
        <div className="chips">
          {(result?.visibleCast ?? []).map((name) => <span key={name} className="chip static">{name}</span>)}
          {result?.cameraAngle ? <span className="chip static">{result.shotSequence ? `${result.shotSequence} · ` : ""}{result.cameraAngle}</span> : null}
        </div>
        <div className="row">
          <button className="btn small" type="button" onClick={() => setEditing(true)}>Sửa</button>
          <button
            className="btn small"
            type="button"
            disabled={studio.phase === "running"}
            onClick={() => void studio.run(studio.lastMode, {
              only: [sceneId],
              prior: studio.results.map((item) => item.sceneId === sceneId ? { ...item, status: "pending", attempts: 0, prompt: "", rejections: [] } : item),
            })}
          >
            Viết lại cảnh này
          </button>
        </div>
      </footer>
    </section>
  );
}

function ReportBody({
  report,
  logs,
  mock,
}: {
  report: NonNullable<ReturnType<typeof useStudio>["report"]>;
  logs: ReturnType<typeof useStudio>["logs"];
  mock: boolean;
}) {
  const reasons = Object.entries(report.rejectionsByReason).sort((a, b) => b[1] - a[1]);
  const max = reasons[0]?.[1] ?? 1;
  return (
    <div className="report-body">
      {mock ? <p className="hint">Mô phỏng dùng prompt mẫu để kiểm tra luồng. Muốn prompt theo đúng lời thoại thì bấm Chạy và dán khóa Gemini.</p> : null}
      <div className="stat-grid">
        <Meter label="Đạt" value={`${report.acceptedPct}%`} />
        <Meter label="Dùng được" value={`${report.usablePct}%`} />
        <Meter label="Thời gian" value={formatMs(report.wallTimeMs)} />
        <Meter label="Token" value={formatTokens(report.tokens.total)} />
        <Meter label="Request" value={String(report.requests)} />
        <Meter label="Lần loại" value={String(report.rejectionEvents)} />
      </div>
      <p className="hint">
        Vào {formatTokens(report.tokens.prompt)}, ra {formatTokens(report.tokens.output)}.
        {report.bible ? " Có story bible." : ""}
        {report.cancelled ? " Đã dừng giữa chừng." : ""}
      </p>
      {report.fatalError ? <p className="banner bad">{report.fatalError}</p> : null}
      {reasons.length ? (
        <ul className="bars">
          {reasons.map(([reason, count]) => (
            <li key={reason}>
              <span>{reason}</span>
              <i style={{ width: `${(count / max) * 100}%` }} />
              <b>{count}</b>
            </li>
          ))}
        </ul>
      ) : <p className="hint">Không có lượt bị loại.</p>}
      <details className="logs">
        <summary>Nhật ký ({logs.length})</summary>
        <ul>
          {logs.slice(-12).map((log) => (
            <li key={log.id}>
              <b>{log.model}</b>
              <span>{log.sceneIds[0]}{log.sceneIds.length > 1 ? `–${log.sceneIds[log.sceneIds.length - 1]}` : ""}</span>
              <span>{log.totalTokens} token</span>
              <span>{log.latencyMs} ms</span>
              <span>{log.rejections.map((item) => item.reasons[0]).filter(Boolean).join(", ") || "ok"}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function Meter({ label, value }: { label: string; value: string }) {
  return (
    <div className="meter">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SettingsDrawer({ studio, onClose }: { studio: ReturnType<typeof useStudio>; onClose: () => void }) {
  const settings = studio.settings;
  const set = studio.setSettings;
  return (
    <div className="scrim" onClick={onClose} role="presentation">
      <aside className="drawer" role="dialog" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
        <div className="row-between">
          <h2 id="settings-title">Cài đặt</h2>
          <button className="btn tiny" type="button" onClick={onClose}>Đóng</button>
        </div>
        <p className="hint">Khóa API chỉ nằm trong trình duyệt này.</p>
        <label>
          Lane chính
          <select value={settings.lane} onChange={(event) => set({ ...settings, lane: event.target.value as typeof settings.lane })}>
            <option value="gemini">Gemini</option>
            <option value="groq">Groq</option>
            <option value="cloudflare">Cloudflare Workers AI</option>
          </select>
        </label>
        <label className="switch">
          <input type="checkbox" checked={settings.directBrowser} onChange={(event) => set({ ...settings, directBrowser: event.target.checked })} />
          <span>Gọi Gemini trực tiếp từ trình duyệt</span>
        </label>
        <label className="switch">
          <input type="checkbox" checked={settings.fullScript !== false} onChange={(event) => set({ ...settings, fullScript: event.target.checked })} />
          <span>Gửi toàn bộ kịch bản trong mỗi lô</span>
        </label>
        <label className="switch">
          <input type="checkbox" checked={settings.bible} onChange={(event) => set({ ...settings, bible: event.target.checked })} />
          <span>Story bible</span>
        </label>
        <label>Gemini API key<input type="password" value={settings.geminiKey} autoComplete="off" onChange={(event) => set({ ...settings, geminiKey: event.target.value })} /></label>
        <label>Model Gemini<input value={settings.geminiModel} onChange={(event) => set({ ...settings, geminiModel: event.target.value })} /></label>
        <label>Model dự phòng<input value={settings.geminiFallbacks} onChange={(event) => set({ ...settings, geminiFallbacks: event.target.value })} /></label>
        <label>Groq API key<input type="password" value={settings.groqKey} autoComplete="off" onChange={(event) => set({ ...settings, groqKey: event.target.value })} /></label>
        <label>Model Groq<input value={settings.groqModel} onChange={(event) => set({ ...settings, groqModel: event.target.value })} /></label>
        <label>Cloudflare account id<input value={settings.cfAccount} onChange={(event) => set({ ...settings, cfAccount: event.target.value })} /></label>
        <label>Cloudflare API token<input type="password" value={settings.cfToken} autoComplete="off" onChange={(event) => set({ ...settings, cfToken: event.target.value })} /></label>
        <label>Model Cloudflare<input value={settings.cfModel} onChange={(event) => set({ ...settings, cfModel: event.target.value })} /></label>
        <div className="split">
          <label>Lô ({settings.batchSize})<input type="range" min={4} max={8} value={settings.batchSize} onChange={(event) => set({ ...settings, batchSize: Number(event.target.value) })} /></label>
          <label>Luồng ({settings.concurrency})<input type="range" min={1} max={6} value={settings.concurrency} onChange={(event) => set({ ...settings, concurrency: Number(event.target.value) })} /></label>
        </div>
        <div className="split">
          <label>RPM<input type="number" min={1} value={settings.rpm} onChange={(event) => set({ ...settings, rpm: Number(event.target.value) })} /></label>
          <label>TPM<input type="number" min={1} value={settings.tpm} onChange={(event) => set({ ...settings, tpm: Number(event.target.value) })} /></label>
          <label>RPD<input type="number" min={1} value={settings.rpd} onChange={(event) => set({ ...settings, rpd: Number(event.target.value) })} /></label>
        </div>
        <label>Số lần viết lại<input type="number" min={1} max={5} value={settings.maxAttempts} onChange={(event) => set({ ...settings, maxAttempts: Number(event.target.value) })} /></label>
        <label>maxOutputTokens<input type="number" min={1024} max={65536} step={256} value={settings.maxOutputTokens} onChange={(event) => set({ ...settings, maxOutputTokens: Number(event.target.value) })} /></label>
        <label>Tiền tố<input value={settings.prefix} onChange={(event) => set({ ...settings, prefix: event.target.value })} /></label>
        <label>Hậu tố<textarea rows={2} value={settings.footer} onChange={(event) => set({ ...settings, footer: event.target.value })} /></label>
        <label>Tên thêm<input value={settings.extraNames} onChange={(event) => set({ ...settings, extraNames: event.target.value })} /></label>
        <p className="hint">Hôm nay {studio.usage.dayKey === studio.dayKey ? studio.usage.count : 0}/{settings.rpd} request. Server: {studio.health?.gemini ? "Gemini sẵn" : "chưa có khóa server"}.</p>
      </aside>
    </div>
  );
}

function Guide({ onClose }: { onClose: () => void }) {
  return (
    <div className="scrim center" onClick={onClose} role="presentation">
      <article className="guide" role="dialog" aria-labelledby="guide-title" onClick={(event) => event.stopPropagation()}>
        <div className="row-between">
          <h2 id="guide-title">Cách dùng</h2>
          <button className="btn tiny" type="button" onClick={onClose}>Đóng</button>
        </div>
        <section>
          <h3>1. Tệp bên trái</h3>
          <p>Thả .srt. Có tiêu đề cảnh thì giữ từng cảnh. Phụ đề thoại thì cắt 8 giây hoặc theo cụm nghĩa. Danh sách cảnh ở tab Cảnh.</p>
        </section>
        <section>
          <h3>2. Một cảnh ở giữa</h3>
          <p>Bấm một dòng để xem lời thoại và prompt cạnh nhau. Sửa tại chỗ, hoặc viết lại đúng cảnh đó.</p>
        </section>
        <section>
          <h3>3. Chạy và xuất</h3>
          <p>Mô phỏng không gọi API. Chạy thật cần khóa Gemini trong Cài đặt. Xuất gói Flow, TXT số hoặc CSV. Báo cáo nằm ở thanh dưới.</p>
        </section>
      </article>
    </div>
  );
}

function ThemeIcon({ dark }: { dark: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r={dark ? 4.2 : 5} fill="currentColor" />
      {dark ? <path d="M12 3.2v2M12 18.8v2M4.6 6.1l1.4 1.4M18 16.5l1.4 1.4M3.2 12h2M18.8 12h2M4.6 17.9l1.4-1.4M18 7.5l1.4-1.4" /> : null}
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6.1 6.1l1.6 1.6M16.3 16.3l1.6 1.6M17.9 6.1l-1.6 1.6M7.7 16.3l-1.6 1.6" />
    </svg>
  );
}
