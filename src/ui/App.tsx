import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Bell,
  Check,
  Clock,
  Cloud,
  Copy,
  Download,
  FileText,
  Folder,
  House,
  ImagePlus,
  LayoutList,
  Maximize2,
  Moon,
  PanelLeft,
  Play,
  RefreshCw,
  Save,
  Search,
  Settings,
  Sun,
  Trash2,
  Upload,
  BarChart3,
  CircleHelp,
} from "lucide-react";
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
  const [listOpen, setListOpen] = useState(true);
  const [stills, setStills] = useState<Record<string, string[]>>({});

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
          <span className="mark" aria-hidden="true"><Play size={16} fill="currentColor" /></span>
          <strong>StoryPrompt</strong>
        </div>
        <button className="file-chip" type="button" onClick={() => setRail("file")} title="Đổi tệp">
          <FileText size={16} /> {studio.fileName || "Chưa có file"}
        </button>
        <div className="top-progress">
          <span>{studio.doneCount} / {studio.scenes.length || 0} cảnh</span>
          <i><b style={{ width: `${counts.pct}%` }} /></i>
          <span>{counts.pct}%</span>
        </div>
        <div className="top-actions">
          {studio.phase === "running" ? (
            <button className="btn danger" type="button" onClick={studio.stop}>Dừng</button>
          ) : (
            <>
              <button className="btn" type="button" title="Mô phỏng, không gọi API" disabled={!studio.scenes.length} onClick={() => void studio.run("mock", { fresh: !continueRun })}>
                <Play size={16} /> Mô phỏng
              </button>
              <button className="btn primary" type="button" title="Chạy với API đã cấu hình" disabled={!studio.scenes.length} onClick={() => void studio.run("live", { fresh: !continueRun })}>
                <Play size={16} /> Chạy
              </button>
            </>
          )}
          <div className="menu">
            <button className="btn" type="button" title="Xuất prompt" disabled={!usable} onClick={() => setExportOpen((open) => !open)}><Download size={16} /> Xuất</button>
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
          <button className="icon-btn" type="button" onClick={() => setRail("report")} aria-label="Báo cáo" title="Báo cáo">
            <Bell size={18} />
            {studio.report ? <i /> : null}
          </button>
          <button className="icon-btn" type="button" onClick={() => studio.setGuideOpen(true)} aria-label="Hướng dẫn" title="Hướng dẫn">
            <CircleHelp size={18} />
          </button>
          <button className="icon-btn sun" type="button" onClick={() => studio.setTheme(studio.theme === "dark" ? "light" : "dark")} aria-label="Đổi nền" title="Đổi nền">
            {studio.theme === "dark" ? <Moon size={18} /> : <Sun size={18} />}
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

      <div className={listOpen ? "body" : "body list-closed"}>
        <nav className="icon-rail" aria-label="Điều hướng">
          <button type="button" onClick={() => setRail("scenes")} aria-label="Tổng quan" title="Tổng quan"><House size={20} /></button>
          <button type="button" className={rail === "scenes" ? "on" : ""} onClick={() => { setRail("scenes"); setListOpen(true); }} aria-label="Cảnh" title="Danh sách cảnh"><LayoutList size={20} /></button>
          <button type="button" className={rail === "report" ? "on" : ""} onClick={() => setRail("report")} aria-label="Báo cáo" title="Báo cáo"><BarChart3 size={20} /></button>
          <button type="button" className={rail === "file" ? "on" : ""} onClick={() => setRail("file")} aria-label="Tệp" title="Tệp"><Folder size={20} /></button>
          <button type="button" onClick={() => studio.setSettingsOpen(true)} aria-label="Cài đặt" title="Cài đặt"><Settings size={20} /></button>
          <button className="rail-end" type="button" onClick={() => setListOpen((open) => !open)} aria-label={listOpen ? "Thu danh sách" : "Mở danh sách"} title={listOpen ? "Thu danh sách" : "Mở danh sách"}><PanelLeft size={20} /></button>
        </nav>
        <div className="main">
          <section className="summary">
            <div className="stat overview-stat">
              <span className="ico" aria-hidden="true"><FileText size={18} /></span>
              <div>
                <strong>Tổng quan dự án</strong>
                <span>{studio.fileName || "Chưa mở file"}</span>
              </div>
            </div>
            <Stat icon={<LayoutList size={18} />} n={studio.scenes.length} label="Tổng số cảnh" />
            <Stat icon={<Check size={18} />} n={counts.done} label="Đã hoàn thành" tone="good" />
            <Stat icon={<Clock size={18} />} n={counts.waiting} label="Đang chờ" />
            <Stat icon={<AlertTriangle size={18} />} n={counts.review} label="Cần kiểm tra" tone="warn" />
            <span className="ring" style={{ ["--p" as string]: String(counts.pct) }}>{counts.pct}%</span>
            <p className="saved"><Cloud size={16} /> {savedAt ? `Đã lưu ${formatClock(savedAt)}` : "Chưa lưu"}</p>
          </section>
          {studio.scenes.length === 0 && rail === "scenes" ? (
            <EmptyStudio studio={studio} dragOver={dragOver} setDragOver={setDragOver} />
          ) : (
          <div className="work">
        {rail === "file" ? (
          <FileColumn studio={studio} dragOver={dragOver} setDragOver={setDragOver} />
        ) : rail === "report" ? (
          <ReportColumn studio={studio} counts={counts} savedAt={savedAt} />
        ) : listOpen ? (
          <aside className="scene-col">
            <div className="search-row">
              <Search size={16} />
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
                    <span className={`sst ${row?.status ?? "pending"}`}>{STATUS_LABEL[row?.status ?? "pending"]}</span>
                  </button>
                );
              })}
            </div>
          </aside>
        ) : null}

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
              timeRange={selected.timeRange || clockRange(selected.start, selected.end)}
              cutReason={selected.cutReason}
              images={stills[selected.sceneId] ?? []}
              onAddImages={(files) => {
                const urls = [...files].map((file) => URL.createObjectURL(file));
                setStills((current) => ({ ...current, [selected.sceneId]: [...(current[selected.sceneId] ?? []), ...urls] }));
              }}
              result={selectedResult}
              onPrev={() => selectedIndex > 0 && setSelectedId(studio.scenes[selectedIndex - 1].sceneId)}
              onNext={() => selectedIndex < studio.scenes.length - 1 && setSelectedId(studio.scenes[selectedIndex + 1].sceneId)}
            />
          )}
        </main>
          </div>
          )}
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

function clockRange(start?: string, end?: string) {
  if (!start || !end) return undefined;
  return `${shortClock(start)} - ${shortClock(end)}`;
}

function shortClock(value: string) {
  const numbers = value.replace(",", ".").split(":").map((part) => Number.parseFloat(part) || 0);
  const total = numbers.length === 3 ? numbers[0] * 3600 + numbers[1] * 60 + numbers[2] : numbers[0] * 60 + (numbers[1] || 0);
  const safe = Math.max(0, Math.floor(total));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function Stat({ n, label, icon, tone }: { n: number | string; label: string; icon?: ReactNode; tone?: "good" | "warn" }) {
  return (
    <div className={tone ? `stat ${tone}` : "stat"}>
      {icon ? <span className="ico" aria-hidden="true">{icon}</span> : null}
      <div>
        <strong>{n}</strong>
        <span>{label}</span>
      </div>
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
  studio, index, total, sceneId, title, source,   timeRange, cutReason, images, onAddImages, result, onPrev, onNext,
}: {
  studio: ReturnType<typeof useStudio>;
  index: number;
  total: number;
  sceneId: string;
  title: string;
  source: string;
  timeRange?: string;
  cutReason?: string;
  images: string[];
  onAddImages: (files: FileList) => void;
  result?: SceneResult;
  onPrev: () => void;
  onNext: () => void;
}) {
  const [draft, setDraft] = useState({ title, environment: "", prompt: "", cast: "" });
  const [copied, setCopied] = useState(false);
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
          <p className="time-line">{timeRange || "Cảnh"}</p>
          <h1>#{sceneId} {cutReason || title || "Cảnh"}</h1>
        </div>
        <div className="pager">
          <button className="btn small" type="button" onClick={onPrev} disabled={index <= 0}>‹ Cảnh trước</button>
          <span>{index + 1} / {total}</span>
          <button className="btn small" type="button" onClick={onNext} disabled={index >= total - 1}>Cảnh sau ›</button>
        </div>
      </header>
      <div className={images.length ? "editor-grid has-still" : "editor-grid"}>
        <div className="stack">
        <article className="card speech">
          <header className="card-h">
            <h2>Lời thoại gốc</h2>
            <span className="badge">SRT</span>
          </header>
          <p className="copy">{source || "Chưa có lời thoại."}</p>
          <div className="count">{source.length.toLocaleString("vi-VN")} / 1.000</div>
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
          <textarea value={draft.prompt} aria-label="Prompt" rows={4} placeholder="Chưa có prompt." onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} />
          <div className="count">{draft.prompt.length.toLocaleString("vi-VN")} / 2.000</div>
          {result?.rejections.length ? <ul className="reasons">{result.rejections.map((reason) => <li key={reason.code}>{reason.detail}</li>)}</ul> : null}
        </article>
        </div>
        {images.length ? <StillColumn images={images} /> : null}
      </div>
      <footer className="editor-bar">
        <button className="btn" type="button" title="Viết lại prompt cảnh này" disabled={studio.phase === "running"} onClick={() => void studio.run(studio.lastMode, { only: [sceneId], prior: studio.results.map((item) => item.sceneId === sceneId ? { ...item, status: "pending", attempts: 0, prompt: "", rejections: [] } : item) })}><RefreshCw size={16} /> Viết lại prompt</button>
        <button className="btn" type="button" title="Sao chép prompt" onClick={() => { void navigator.clipboard.writeText(shown || draft.prompt); setCopied(true); window.setTimeout(() => setCopied(false), 1400); }}>{copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Đã chép" : "Sao chép"}</button>
        <button className="btn ghost" type="button" title="Xóa nội dung prompt" onClick={() => setDraft({ ...draft, prompt: "" })}><Trash2 size={16} /> Xóa nội dung</button>
        <label className="btn" title="Gắn ảnh cho cảnh này">
          <ImagePlus size={16} /> Thêm ảnh
          <input type="file" accept="image/*" multiple hidden onChange={(event) => { if (event.target.files?.length) onAddImages(event.target.files); event.target.value = ""; }} />
        </label>
        <label className="status-select">Trạng thái:
          <select value={result?.status ?? "pending"} disabled aria-label="Trạng thái">
            <option value={result?.status ?? "pending"}>{STATUS_LABEL[result?.status ?? "pending"]}</option>
          </select>
        </label>
        <button className="btn primary" type="button" title="Lưu (Ctrl + S)" onClick={() => studio.saveEdit(sceneId, { ...draft, cast: draft.cast || result?.visibleCast.join(", ") || "" })}><Save size={16} /> Lưu</button>
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

function StillColumn({ images }: { images: string[] }) {
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState(false);
  const safe = Math.min(index, Math.max(0, images.length - 1));
  const src = images[safe];
  if (!src) return null;
  return (
    <article className="card preview-card">
      <div className="photo">
        <img src={src} alt="Ảnh minh họa của cảnh" />
        <span className="frame-label">Ảnh minh họa</span>
        <button className="btn tiny zoom" type="button" onClick={() => setZoom(true)} aria-label="Phóng to"><Maximize2 size={14} /></button>
      </div>
      {images.length > 1 ? (
        <div className="thumbs">
          <button type="button" className="thumb-nav" onClick={() => setIndex((value) => (value + images.length - 1) % images.length)} aria-label="Ảnh trước">‹</button>
          {images.map((item, thumb) => (
            <button key={`${thumb}-${item}`} type="button" className={thumb === safe ? "on" : ""} onClick={() => setIndex(thumb)} aria-label={`Ảnh ${thumb + 1}`}>
              <img src={item} alt="" />
            </button>
          ))}
          <button type="button" className="thumb-nav" onClick={() => setIndex((value) => (value + 1) % images.length)} aria-label="Ảnh sau">›</button>
        </div>
      ) : null}
      {zoom ? (
        <dialog className="lightbox" open onClick={() => setZoom(false)}>
          <img src={src} alt="Ảnh minh họa phóng to" />
        </dialog>
      ) : null}
    </article>
  );
}

function EmptyStudio({ studio, dragOver, setDragOver }: { studio: ReturnType<typeof useStudio>; dragOver: boolean; setDragOver: (value: boolean) => void }) {
  return (
    <section className="empty-screen">
      <article className="card empty-card">
        <span className="ico" aria-hidden="true"><Upload size={22} /></span>
        <h1>Mở kịch bản</h1>
        <p className="muted">Thả file .srt hoặc .txt. App chia cảnh và viết prompt tiếng Anh cho Google Flow.</p>
        <DropBox studio={studio} dragOver={dragOver} setDragOver={setDragOver} />
        <button className="btn primary" type="button" onClick={() => void studio.loadSample()}><FileText size={16} /> Mở file mẫu</button>
      </article>
    </section>
  );
}

function Guide({ onClose }: { onClose: () => void }) {
  return (
    <div className="scrim center" onClick={onClose} role="presentation">
      <article className="guide" role="dialog" aria-labelledby="guide-title" onClick={(event) => event.stopPropagation()}>
        <div className="row-between"><h2 id="guide-title">Cách dùng</h2><button className="btn tiny" type="button" onClick={onClose}>Đóng</button></div>
        <p>Danh sách cảnh ở bên trái. Lời thoại và prompt xếp cùng một cột. Ảnh chỉ hiện khi cảnh có ảnh riêng, tỷ lệ 16:9.</p>
        <p>Mô phỏng không gọi API. Chạy thật cần khóa Gemini trong Cài đặt. Xuất nằm ở nút Xuất trên thanh trên.</p>
      </article>
    </div>
  );
}

