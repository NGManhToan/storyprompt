import { useEffect, useMemo, useState } from "react";
import type { SceneResult } from "../core/types.js";
import { wrapPrompt } from "../core/export.js";
import { useStudio } from "./useStudio.js";

const STATUS_LABEL: Record<string, string> = {
  pending: "Đang chờ",
  running: "Đang viết",
  accepted: "Đã xong",
  rejected: "Cần kiểm tra",
  missing: "Cần kiểm tra",
  edited: "Đã sửa",
  failed: "Cần kiểm tra",
};

const STYLES = [
  {
    id: "webtoon",
    label: "Webtoon",
    prefix: "",
    footer: "modern 2D webtoon comic style, crisp ink line art, cel-shaded, warm daylight, clean frame, no text, 16:9",
  },
  {
    id: "cinematic",
    label: "Cinematic",
    prefix: "",
    footer: "cinematic still, natural light, 16:9, no rendered text",
  },
] as const;

function formatClock(ms: number) {
  const date = new Date(ms);
  return date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

export function App() {
  const studio = useStudio();
  const [rail, setRail] = useState<"scenes" | "file" | "report">("scenes");
  const [query, setQuery] = useState("");
  const [listFilter, setListFilter] = useState<"all" | "done" | "waiting" | "review">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const selected = studio.scenes.find((scene) => scene.sceneId === selectedId) ?? studio.scenes[0];
  const selectedResult = studio.results.find((row) => row.sceneId === selected?.sceneId);
  const selectedIndex = selected ? studio.scenes.findIndex((scene) => scene.sceneId === selected.sceneId) : -1;

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
    const done = studio.results.filter((row) => row.status === "accepted" || row.status === "edited").length;
    const review = studio.results.filter((row) => row.status === "failed" || row.status === "rejected" || row.status === "missing").length;
    const waiting = Math.max(0, studio.scenes.length - done - review);
    const pct = studio.scenes.length ? Math.round((done / studio.scenes.length) * 100) : 0;
    return { done, review, waiting, pct };
  }, [studio.results, studio.scenes.length]);

  const visibleScenes = studio.scenes.filter((scene) => {
    const row = studio.results.find((item) => item.sceneId === scene.sceneId);
    const status = row?.status ?? "pending";
    if (listFilter === "done" && status !== "accepted" && status !== "edited") return false;
    if (listFilter === "waiting" && status !== "pending" && status !== "running") return false;
    if (listFilter === "review" && status !== "failed" && status !== "rejected" && status !== "missing") return false;
    if (!query.trim()) return true;
    const haystack = `${scene.sceneId} ${scene.source} ${row?.prompt ?? ""}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  const savedAt = studio.report?.finishedAt;
  const usable = studio.results.some((row) => row.prompt && (row.status === "accepted" || row.status === "edited"));
  const continueRun = usable;

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <strong>StoryPrompt</strong>
        </div>
        <button className="file-chip" type="button" onClick={() => setRail("file")}>
          {studio.fileName || "Chưa có file"}
        </button>
        <div className="top-progress">
          <span>{studio.doneCount}/{studio.scenes.length || 0} cảnh</span>
          <i><b style={{ width: `${counts.pct}%` }} /></i>
          <span>{counts.pct}%</span>
        </div>
        <div className="top-actions">
          {studio.phase === "running" ? (
            <button className="btn danger" type="button" onClick={studio.stop}>Dừng</button>
          ) : (
            <>
              <button className="btn" type="button" disabled={!studio.scenes.length} onClick={() => void studio.run("mock", { fresh: !continueRun })}>
                <PlayIcon /> Mô phỏng
              </button>
              <button className="btn primary" type="button" disabled={!studio.scenes.length} onClick={() => void studio.run("live", { fresh: !continueRun })}>
                <PlayIcon /> Chạy
              </button>
            </>
          )}
          <div className="menu">
            <button className="btn" type="button" disabled={!usable} onClick={() => setExportOpen((open) => !open)}>Xuất</button>
            {exportOpen && usable ? (
              <div className="menu-pop">
                <button type="button" onClick={() => { void studio.copyAll(); setExportOpen(false); }}>Sao chép tất cả</button>
                <button type="button" onClick={() => { studio.download("numbered"); setExportOpen(false); }}>TXT số</button>
                <button type="button" onClick={() => { studio.download("flow"); setExportOpen(false); }}>Gói Flow</button>
                <button type="button" onClick={() => { studio.download("json"); setExportOpen(false); }}>JSON</button>
                <button type="button" onClick={() => { studio.download("csv"); setExportOpen(false); }}>CSV</button>
              </div>
            ) : null}
          </div>
          <button className="icon-btn" type="button" onClick={() => setRail("report")} aria-label="Báo cáo">
            <BellIcon />
            {studio.report ? <i /> : null}
          </button>
          <button className="icon-btn" type="button" onClick={() => studio.setGuideOpen(true)} aria-label="Hướng dẫn">?</button>
          <button className="icon-btn" type="button" onClick={() => studio.setTheme(studio.theme === "dark" ? "light" : "dark")} aria-label="Đổi nền">
            <ThemeIcon dark={studio.theme === "dark"} />
          </button>
        </div>
      </header>

      {studio.error ? <p className="flash bad">{studio.error}</p> : null}
      {studio.resumeOffer ? (
        <div className="flash">
          <span>Có bản lưu {new Date(studio.resumeOffer.savedAt).toLocaleString("vi-VN")}.</span>
          <button className="btn small" type="button" onClick={() => studio.applyCheckpoint(studio.resumeOffer!)}>Tiếp tục</button>
          <button className="btn ghost small" type="button" onClick={studio.dismissResume}>Bỏ</button>
        </div>
      ) : null}

      <div className="body">
        <nav className="icon-rail" aria-label="Điều hướng">
          <button type="button" onClick={() => setRail("scenes")} aria-label="Tổng quan"><HomeIcon /></button>
          <button type="button" className={rail === "scenes" ? "on" : ""} onClick={() => setRail("scenes")} aria-label="Cảnh"><ListIcon /></button>
          <button type="button" className={rail === "report" ? "on" : ""} onClick={() => setRail("report")} aria-label="Báo cáo"><ChartIcon /></button>
          <button type="button" className={rail === "file" ? "on" : ""} onClick={() => setRail("file")} aria-label="Tệp"><FolderIcon /></button>
          <button type="button" onClick={() => studio.setSettingsOpen(true)} aria-label="Cài đặt"><GearIcon /></button>
        </nav>
        <div className="main">
          <section className="summary">
            <div className="overview">
              <p>Tổng quan dự án</p>
              <strong>{studio.fileName || "Chưa mở file"}</strong>
            </div>
            <Stat n={studio.scenes.length} label="Tổng số cảnh" />
            <Stat n={counts.done} label="Đã hoàn thành" tone="good" />
            <Stat n={counts.waiting} label="Đang chờ" />
            <Stat n={counts.review} label="Cần kiểm tra" tone="warn" />
            <span className="ring" style={{ ["--p" as string]: String(counts.pct) }}>{counts.pct}%</span>
            <p className="saved">{savedAt ? `Đã lưu tự động ${new Date(savedAt).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" })}` : "Chưa lưu tự động"}</p>
          </section>
          <div className="work">
        {rail === "file" ? (
          <FileColumn studio={studio} dragOver={dragOver} setDragOver={setDragOver} />
        ) : rail === "report" ? (
          <ReportColumn studio={studio} counts={counts} savedAt={savedAt} />
        ) : (
          <aside className="scene-col">
            <div className="search-row">
              <input className="search" value={query} placeholder="Tìm cảnh hoặc lời thoại..." aria-label="Tìm cảnh" onChange={(event) => setQuery(event.target.value)} />
            </div>
            <div className="filters">
              {(
                [
                  ["all", `Tất cả (${studio.scenes.length})`],
                  ["done", `Đã xong (${counts.done})`],
                  ["waiting", `Đang chờ (${counts.waiting})`],
                  ["review", `Cần kiểm tra (${counts.review})`],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" className={listFilter === id ? "pill on" : "pill"} onClick={() => setListFilter(id)}>{label}</button>
              ))}
            </div>
            <div className="scene-list">
              {visibleScenes.map((scene) => {
                const row = studio.results.find((item) => item.sceneId === scene.sceneId);
                return (
                  <button key={scene.sceneId} type="button" className={scene.sceneId === selected?.sceneId ? "scene-row on" : "scene-row"} onClick={() => setSelectedId(scene.sceneId)}>
                    <span className={`dot ${row?.status ?? "pending"}`} />
                    <span className="sid">#{scene.sceneId}</span>
                    <span className="stime">{scene.timeRange || oneLine(scene.source)}</span>
                    <span className="sst">{STATUS_LABEL[row?.status ?? "pending"]}</span>
                  </button>
                );
              })}
            </div>
          </aside>
        )}

        <main className="stage">
          {!selected ? (
            <section className="empty">
              <p className="kicker">SRT → prompt</p>
              <h1>Mỗi cảnh một khung hình.</h1>
              <DropBox studio={studio} dragOver={dragOver} setDragOver={setDragOver} />
              <button className="btn primary" type="button" onClick={() => void studio.loadSample()}>Mở file mẫu</button>
            </section>
          ) : (
            <SceneStage
              studio={studio}
              index={selectedIndex}
              total={studio.scenes.length}
              sceneId={selected.sceneId}
              title={selected.title}
              source={selected.source}
              timeRange={selected.timeRange}
              cutReason={selected.cutReason}
              result={selectedResult}
              onPrev={() => selectedIndex > 0 && setSelectedId(studio.scenes[selectedIndex - 1].sceneId)}
              onNext={() => selectedIndex < studio.scenes.length - 1 && setSelectedId(studio.scenes[selectedIndex + 1].sceneId)}
            />
          )}
        </main>
          </div>
        </div>
      </div>

      {studio.toast ? <div className="toast">{studio.toast}</div> : null}
      {studio.guideOpen ? <Guide onClose={() => studio.setGuideOpen(false)} /> : null}
      {studio.settingsOpen ? <SettingsDrawer studio={studio} onClose={() => studio.setSettingsOpen(false)} /> : null}
    </div>
  );
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 42);
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: "good" | "warn" }) {
  return (
    <div className={tone ? `stat ${tone}` : "stat"}>
      <strong>{n}</strong>
      <span>{label}</span>
    </div>
  );
}

function DropBox({ studio, dragOver, setDragOver }: { studio: ReturnType<typeof useStudio>; dragOver: boolean; setDragOver: (v: boolean) => void }) {
  return (
    <label className={dragOver ? "drop over" : "drop"} onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={(event) => { event.preventDefault(); setDragOver(false); const file = event.dataTransfer.files?.[0]; if (file) void studio.onFile(file); }}>
      <input type="file" accept=".srt,.txt,text/plain" onChange={(event) => { const file = event.target.files?.[0]; if (file) void studio.onFile(file); }} />
      <span>{studio.fileName || "Thả file .srt hoặc .txt"}</span>
    </label>
  );
}

function FileColumn({ studio, dragOver, setDragOver }: { studio: ReturnType<typeof useStudio>; dragOver: boolean; setDragOver: (v: boolean) => void }) {
  const [name, setName] = useState("");
  return (
    <aside className="scene-col file-col">
      <p className="kicker">Tệp</p>
      <DropBox studio={studio} dragOver={dragOver} setDragOver={setDragOver} />
      <button className="btn ghost" type="button" onClick={() => void studio.loadSample()}>File mẫu 20 cảnh</button>
      <div className="filters">
        {(
          [
            ["headings", "Theo cảnh"],
            ["fixed", `${studio.duration}s`],
            ["sense", "Cụm nghĩa"],
          ] as const
        ).map(([mode, label]) => (
          <button key={mode} type="button" className={studio.chunkMode === mode ? "pill on" : "pill"} onClick={() => studio.recut(mode, studio.duration)}>{label}</button>
        ))}
      </div>
      <label>Nhịp<select value={studio.duration} onChange={(event) => studio.recut(studio.chunkMode === "headings" ? "fixed" : studio.chunkMode, Number(event.target.value))}>{[4, 6, 8, 10, 12].map((seconds) => <option key={seconds} value={seconds}>{seconds} giây</option>)}</select></label>
      <label>Kịch bản gốc<textarea rows={4} value={studio.masterScript} onChange={(event) => studio.setMasterScript(event.target.value)} /></label>
      <label>Chủ đề<input value={studio.settings.topic} onChange={(event) => studio.setSettings({ ...studio.settings, topic: event.target.value })} /></label>
      <label>Người kể<input value={studio.settings.protagonist} onChange={(event) => studio.setSettings({ ...studio.settings, protagonist: event.target.value })} /></label>
      <div className="chips">{studio.knownNames.map((item) => <button key={item} type="button" className="chip" onClick={() => studio.removeName(item)}>{item} ×</button>)}</div>
      <form className="add-name" onSubmit={(event) => { event.preventDefault(); studio.addName(name); setName(""); }}>
        <input value={name} placeholder="Thêm tên" aria-label="Thêm tên" onChange={(event) => setName(event.target.value)} />
        <button className="btn small" type="submit">Thêm</button>
      </form>
    </aside>
  );
}

function ReportColumn({ studio, counts, savedAt }: { studio: ReturnType<typeof useStudio>; counts: { done: number; review: number; waiting: number; pct: number }; savedAt?: number }) {
  const report = studio.report;
  const reasons = report ? Object.entries(report.rejectionsByReason).sort((a, b) => b[1] - a[1]) : [];
  const max = reasons[0]?.[1] ?? 1;
  return (
    <aside className="scene-col report-col">
      <p className="kicker">{studio.lastMode === "mock" && report ? "Báo cáo mô phỏng" : "Báo cáo lượt chạy"}</p>
      {!report ? <p className="muted">Số đo hiện sau khi chạy. Mô phỏng không gọi API.</p> : (
        <>
          {studio.lastMode === "mock" ? <p className="muted">Prompt mẫu để xem luồng. Muốn đúng lời thoại thì bấm Chạy.</p> : null}
          <div className="stats">
            <Stat n={counts.pct} label="% đạt" tone="good" />
            <Stat n={report.requests} label="Request" />
            <Stat n={report.rejectionEvents} label="Lần loại" tone="warn" />
          </div>
          <p className="muted">{formatDuration(report.wallTimeMs)} · {report.tokens.total.toLocaleString("vi-VN")} token</p>
          <ul className="bars">
            {reasons.map(([reason, count]) => (
              <li key={reason}><span>{reason}</span><i style={{ width: `${(count / max) * 100}%` }} /><b>{count}</b></li>
            ))}
          </ul>
          <p className="muted">{savedAt ? `Xong lúc ${formatClock(savedAt)}` : ""}</p>
        </>
      )}
    </aside>
  );
}

function formatDuration(ms: number) {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} giây`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function SceneStage({
  studio, index, total, sceneId, title, source, timeRange, cutReason, result, onPrev, onNext,
}: {
  studio: ReturnType<typeof useStudio>;
  index: number;
  total: number;
  sceneId: string;
  title: string;
  source: string;
  timeRange?: string;
  cutReason?: string;
  result?: SceneResult;
  onPrev: () => void;
  onNext: () => void;
}) {
  const [draft, setDraft] = useState({ title, environment: "", prompt: "", cast: "" });
  useEffect(() => {
    setDraft({
      title: result?.title || title,
      environment: result?.environment || "",
      prompt: result?.prompt || "",
      cast: result?.visibleCast.join(", ") || "",
    });
  }, [sceneId, result?.prompt, result?.title, result?.environment, result?.visibleCast, title]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        studio.saveEdit(sceneId, {
          ...draft,
          cast: draft.cast,
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [studio, sceneId, draft]);

  const styleId = STYLES.find((item) => item.footer === studio.settings.footer)?.id ?? "webtoon";
  const shown = draft.prompt ? wrapPrompt(draft.prompt, studio.settings.prefix, studio.settings.footer) : "";

  return (
    <section className="editor">
      <header className="editor-head">
        <div>
          <p className="kicker">{timeRange || "Cảnh"}</p>
          <h1>#{sceneId} {cutReason || title || "Cảnh"}</h1>
        </div>
        <div className="pager">
          <button className="btn small" type="button" onClick={onPrev} disabled={index <= 0}>‹ Cảnh trước</button>
          <span>{index + 1} / {total}</span>
          <button className="btn small" type="button" onClick={onNext} disabled={index >= total - 1}>Cảnh sau ›</button>
        </div>
      </header>
      <div className="editor-grid">
        <article className="card speech">
          <header className="card-h">
            <h2>Lời thoại gốc (Tiếng Anh)</h2>
            <span className="badge">SRT</span>
          </header>
          <p className="copy">{source}</p>
          <span className="count">{source.length.toLocaleString("vi-VN")} / 1.000</span>
        </article>
        <article className="card frame">
          <div className="frame-well">
            <span className="frame-label">Ảnh minh họa</span>
            <p>Khung dành cho ảnh Google Flow</p>
          </div>
          <div className="thumbs" aria-hidden="true">
            <button type="button" className="thumb-nav">‹</button>
            <span /><span /><span /><span />
            <button type="button" className="thumb-nav">›</button>
          </div>
        </article>
        <article className="card prompt-card">
          <header className="card-h">
            <h2>Prompt (Tiếng Anh)</h2>
            <select
              aria-label="Phong cách"
              value={styleId}
              onChange={(event) => {
                const next = STYLES.find((item) => item.id === event.target.value) ?? STYLES[0];
                studio.setSettings({ ...studio.settings, prefix: next.prefix, footer: next.footer });
              }}
            >
              {STYLES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </header>
          <textarea value={draft.prompt} aria-label="Prompt" rows={5} placeholder="Chưa có prompt." onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} />
          <span className="count">{draft.prompt.length.toLocaleString("vi-VN")} / 2.000</span>
          {result?.rejections.length ? <ul className="reasons">{result.rejections.map((reason) => <li key={reason.code}>{reason.detail}</li>)}</ul> : null}
        </article>
      </div>
      <footer className="editor-bar">
        <button className="btn" type="button" disabled={studio.phase === "running"} onClick={() => void studio.run(studio.lastMode, { only: [sceneId], prior: studio.results.map((item) => item.sceneId === sceneId ? { ...item, status: "pending", attempts: 0, prompt: "", rejections: [] } : item) })}>Viết lại prompt</button>
        <button className="btn" type="button" onClick={() => void navigator.clipboard.writeText(shown || draft.prompt)}>Sao chép</button>
        <button className="btn ghost" type="button" onClick={() => setDraft({ ...draft, prompt: "" })}>Xóa nội dung</button>
        <label className="status-select">Trạng thái:
          <select value={result?.status ?? "pending"} disabled aria-label="Trạng thái">
            <option value={result?.status ?? "pending"}>{STATUS_LABEL[result?.status ?? "pending"]}</option>
          </select>
        </label>
        <button className="btn primary" type="button" onClick={() => studio.saveEdit(sceneId, { ...draft, cast: draft.cast || result?.visibleCast.join(", ") || "" })}>Lưu (Ctrl + S)</button>
      </footer>
    </section>
  );
}

function SettingsDrawer({ studio, onClose }: { studio: ReturnType<typeof useStudio>; onClose: () => void }) {
  const settings = studio.settings;
  const set = studio.setSettings;
  return (
    <div className="scrim" onClick={onClose} role="presentation">
      <aside className="drawer" role="dialog" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
        <div className="row-between"><h2 id="settings-title">Cài đặt</h2><button className="btn tiny" type="button" onClick={onClose}>Đóng</button></div>
        <p className="muted">Khóa chỉ nằm trên trình duyệt này.</p>
        <label>Lane<select value={settings.lane} onChange={(event) => set({ ...settings, lane: event.target.value as typeof settings.lane })}><option value="gemini">Gemini</option><option value="groq">Groq</option><option value="cloudflare">Cloudflare</option></select></label>
        <label className="switch"><input type="checkbox" checked={settings.directBrowser} onChange={(event) => set({ ...settings, directBrowser: event.target.checked })} /><span>Gọi Gemini trực tiếp</span></label>
        <label className="switch"><input type="checkbox" checked={settings.fullScript !== false} onChange={(event) => set({ ...settings, fullScript: event.target.checked })} /><span>Gửi cả kịch bản mỗi lô</span></label>
        <label className="switch"><input type="checkbox" checked={settings.bible} onChange={(event) => set({ ...settings, bible: event.target.checked })} /><span>Story bible</span></label>
        <label>Gemini API key<input type="password" autoComplete="off" value={settings.geminiKey} onChange={(event) => set({ ...settings, geminiKey: event.target.value })} /></label>
        <label>Model Gemini<input value={settings.geminiModel} onChange={(event) => set({ ...settings, geminiModel: event.target.value })} /></label>
        <label>Model dự phòng<input value={settings.geminiFallbacks} onChange={(event) => set({ ...settings, geminiFallbacks: event.target.value })} /></label>
        <label>Groq API key<input type="password" autoComplete="off" value={settings.groqKey} onChange={(event) => set({ ...settings, groqKey: event.target.value })} /></label>
        <label>Model Groq<input value={settings.groqModel} onChange={(event) => set({ ...settings, groqModel: event.target.value })} /></label>
        <label>Cloudflare account id<input value={settings.cfAccount} onChange={(event) => set({ ...settings, cfAccount: event.target.value })} /></label>
        <label>Cloudflare API token<input type="password" autoComplete="off" value={settings.cfToken} onChange={(event) => set({ ...settings, cfToken: event.target.value })} /></label>
        <label>Model Cloudflare<input value={settings.cfModel} onChange={(event) => set({ ...settings, cfModel: event.target.value })} /></label>
        <div className="split">
          <label>Lô {settings.batchSize}<input type="range" min={4} max={8} value={settings.batchSize} onChange={(event) => set({ ...settings, batchSize: Number(event.target.value) })} /></label>
          <label>Luồng {settings.concurrency}<input type="range" min={1} max={6} value={settings.concurrency} onChange={(event) => set({ ...settings, concurrency: Number(event.target.value) })} /></label>
        </div>
        <div className="split">
          <label>RPM<input type="number" min={1} value={settings.rpm} onChange={(event) => set({ ...settings, rpm: Number(event.target.value) })} /></label>
          <label>TPM<input type="number" min={1} value={settings.tpm} onChange={(event) => set({ ...settings, tpm: Number(event.target.value) })} /></label>
          <label>RPD<input type="number" min={1} value={settings.rpd} onChange={(event) => set({ ...settings, rpd: Number(event.target.value) })} /></label>
        </div>
        <label>Hậu tố<textarea rows={2} value={settings.footer} onChange={(event) => set({ ...settings, footer: event.target.value })} /></label>
        <label>Tên thêm<input value={settings.extraNames} onChange={(event) => set({ ...settings, extraNames: event.target.value })} /></label>
      </aside>
    </div>
  );
}

function Guide({ onClose }: { onClose: () => void }) {
  return (
    <div className="scrim center" onClick={onClose} role="presentation">
      <article className="guide" role="dialog" aria-labelledby="guide-title" onClick={(event) => event.stopPropagation()}>
        <div className="row-between"><h2 id="guide-title">Cách dùng</h2><button className="btn tiny" type="button" onClick={onClose}>Đóng</button></div>
        <p>Cột trái là danh sách cảnh. Bấm một dòng để xem lời thoại và prompt. Ảnh minh họa để dành cho Google Flow, app không tạo ảnh.</p>
        <p>Mô phỏng không gọi API. Chạy thật cần khóa Gemini trong Cài đặt. Xuất nằm ở nút Xuất trên thanh trên.</p>
      </article>
    </div>
  );
}

function HomeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11 12 4l8 7v9H4z" /></svg>;
}
function PlayIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7v10l8-5z" fill="currentColor" stroke="none" /></svg>;
}
function ThemeIcon({ dark }: { dark: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r={dark ? 4 : 5} /><path d="M12 3v2M12 19v2M3 12h2M19 12h2" /></svg>;
}
function GearIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2" /></svg>;
}
function ListIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h10" /></svg>;
}
function FolderIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l2 2h9v8.5h-17z" /></svg>;
}
function ChartIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V10M12 19V5M19 19v-7" /></svg>;
}
function BellIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16h12l-1.2-2.2V10a4.8 4.8 0 1 0-9.6 0v3.8zM10 18a2 2 0 0 0 4 0" /></svg>;
}
