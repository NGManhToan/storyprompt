import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cloud,
  Copy,
  Download,
  FileText,
  Folder,
  House,
  ImagePlus,
  LayoutGrid,
  Upload,
  Maximize2,
  Moon,
  Play,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
} from "lucide-react";
import type { SceneResult } from "../core/types.js";
import { wrapPrompt } from "../core/export.js";
import { loadStills, saveStills } from "./storage.js";
import { useStudio } from "./useStudio.js";

const STYLES = [
  { id: "cinematic", label: "Cinematic", prefix: "", footer: "cinematic still, natural light, 16:9, no rendered text" },
  { id: "webtoon", label: "Webtoon", prefix: "", footer: "modern 2D webtoon comic style, crisp ink line art, cel-shaded, warm daylight, clean frame, no text, 16:9" },
  { id: "realistic", label: "Realistic", prefix: "", footer: "realistic live-action still, natural light, 16:9, no rendered text" },
] as const;

const FIXTURE_PROMPT = "A cinematic wide shot of a city street at 8:03 AM on a gray Monday at the end of winter. Overcast sky, leafless trees, wet pavement, people in coats walking, calm and realistic mood.";
const FIXTURE_STILLS = ["/fixtures/still-1.jpg", "/fixtures/still-2.jpg", "/fixtures/still-3.jpg", "/fixtures/still-4.jpg"];

type Bucket = "waiting" | "done" | "review";

function bucket(status?: string): Bucket {
  if (status === "accepted" || status === "edited") return "done";
  if (status === "failed" || status === "rejected" || status === "missing") return "review";
  return "waiting";
}

const BUCKET_LABEL: Record<Bucket, string> = {
  waiting: "Đang chờ",
  done: "Đã xong",
  review: "Cần kiểm tra",
};

function dashRange(value?: string) {
  return (value || "").replace(" - ", " – ");
}

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function App() {
  const studio = useStudio();
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const fixtureStarted = useRef(false);
  const [query, setQuery] = useState("");
  const [listFilter, setListFilter] = useState<Bucket | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [stills, setStills] = useState<Record<string, string[]>>({});
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "unsaved" | "saving" | "saved" | "failed">("idle");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dragOver, setDragOver] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    document.body.classList.toggle("dark", studio.theme === "dark");
  }, [studio.theme]);

  useEffect(() => {
    if (fixtureStarted.current) return;
    if (!new URLSearchParams(window.location.search).has("fixture")) return;
    fixtureStarted.current = true;
    void (async () => {
      const text = await fetch("/fixtures/voice-fin-001.srt").then((response) => response.text());
      await studio.onFile(new File([text], "voice fin 001.srt", { type: "application/x-subrip" }));
      setStills({ "001": FIXTURE_STILLS });
      const cinematic = STYLES[0];
      studio.setSettings({ ...studio.settings, prefix: cinematic.prefix, footer: cinematic.footer });
    })();
  }, [studio]);

  useEffect(() => {
    if (!studio.scenes.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !studio.scenes.some((scene) => scene.sceneId === selectedId)) {
      setSelectedId(studio.scenes[0].sceneId);
    }
  }, [studio.scenes, selectedId]);

  useEffect(() => {
    if (!studio.project) return;
    let cancel = false;
    void loadStills(studio.project).then((rows) => {
      if (!cancel && rows) setStills((current) => ({ ...rows, ...current }));
    });
    return () => {
      cancel = true;
    };
  }, [studio.project]);

  useEffect(() => {
    if (!studio.project) return;
    void saveStills(studio.project, stills);
  }, [studio.project, stills]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const counts = useMemo(() => {
    const done = studio.results.filter((row) => bucket(row.status) === "done").length;
    const review = studio.results.filter((row) => bucket(row.status) === "review").length;
    const waiting = Math.max(0, studio.scenes.length - done - review);
    const pct = studio.scenes.length ? Math.round((done / studio.scenes.length) * 100) : 0;
    return { done, review, waiting, pct };
  }, [studio.results, studio.scenes.length]);

  const visibleScenes = studio.scenes.filter((scene) => {
    const row = studio.results.find((item) => item.sceneId === scene.sceneId);
    const status = bucket(row?.status);
    if (listFilter !== "all" && status !== listFilter) return false;
    if (!query.trim()) return true;
    const haystack = `${scene.sceneId} ${scene.source} ${row?.prompt ?? ""}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  const selected = studio.scenes.find((scene) => scene.sceneId === selectedId) ?? studio.scenes[0];
  const selectedResult = studio.results.find((row) => row.sceneId === selected?.sceneId);
  const selectedIndex = selected ? studio.scenes.findIndex((scene) => scene.sceneId === selected.sceneId) : -1;
  const usable = studio.results.some((row) => row.prompt && (row.status === "accepted" || row.status === "edited"));
  const images = selected ? stills[selected.sceneId] ?? [] : [];

  useEffect(() => {
    if (!selected) return;
    const text = drafts[selected.sceneId];
    if (text === undefined || text === (selectedResult?.prompt ?? "")) return;
    setSaveState("unsaved");
    const timer = window.setTimeout(() => {
      setSaveState("saving");
      try {
        studio.saveEdit(selected.sceneId, {
          title: selected.cutReason || selected.title,
          environment: selectedResult?.environment || "",
          prompt: text,
          cast: selectedResult?.visibleCast.join(", ") || "",
        });
        setSaveState("saved");
        setSavedAt(Date.now());
      } catch {
        setSaveState("failed");
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [drafts, selected, selectedResult, studio]);

  function openFile() {
    fileRef.current?.click();
  }

  function takeFiles(list: FileList | File[]) {
    const files = [...list];
    const script = files.find((file) => /\.(srt|txt)$/i.test(file.name));
    const pictures = files.filter((file) => file.type.startsWith("image/"));
    if (script) void studio.onFile(script);
    if (!script && !pictures.length && files.length) setNotice("Chỉ nhận file .srt hoặc .txt.");
    if (pictures.length && selected) void addImages(selected.sceneId, pictures);
  }

  async function addImages(sceneId: string, pictures: File[]) {
    const urls = await Promise.all(pictures.map((file) => readDataUrl(file)));
    setStills((current) => ({ ...current, [sceneId]: [...(current[sceneId] ?? []), ...urls] }));
  }

  function removeImage(sceneId: string, index: number) {
    setStills((current) => ({ ...current, [sceneId]: (current[sceneId] ?? []).filter((_, item) => item !== index) }));
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("Đã sao chép");
    } catch {
      setNotice("Không thể truy cập clipboard");
    }
  }

  const savedLabel = saveState === "saving"
    ? "Đang lưu"
    : saveState === "failed"
      ? "Lưu thất bại"
      : saveState === "saved" && savedAt
        ? `Đã lưu ${new Date(savedAt).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" })}`
        : saveState === "unsaved"
          ? "Chưa lưu"
          : "Chưa lưu";

  return (
    <>
      <header>
        <div className="brand"><span className="logo" title="StoryPrompt"><Play size={16} fill="currentColor" strokeWidth={0} /></span> StoryPrompt</div>
        <button className="file" type="button" onClick={openFile}>
          <FileText size={16} /> {studio.fileName || "Chưa có file"} <ChevronDown size={14} />
        </button>
        <input ref={fileRef} type="file" accept=".srt,.txt,image/*" onChange={(event) => { if (event.target.files) takeFiles(event.target.files); event.target.value = ""; }} />
        <div className="progress">{counts.done} / {studio.scenes.length || 0} cảnh <div className="track"><i style={{ width: `${counts.pct}%` }} /></div> {counts.pct}%</div>
        <div className="head-actions">
          {studio.phase === "running" ? (
            <button type="button" onClick={studio.stop}>Dừng</button>
          ) : (
            <>
              <button type="button" title="Mô phỏng, không gọi API" disabled={!studio.scenes.length} onClick={() => void studio.run("mock", { fresh: !usable })}><Play size={14} /> Mô phỏng</button>
              <button className="primary" type="button" title="Chạy với khóa đã lưu trên máy" disabled={!studio.scenes.length} onClick={() => void studio.run("live", { fresh: !usable })}><Play size={14} /> Chạy</button>
            </>
          )}
          <div className="menu">
            <button type="button" title="Xuất prompt" disabled={!usable} onClick={() => setExportOpen((open) => !open)}><Download size={14} /> Xuất</button>
            {exportOpen ? (
              <div className="menu-pop">
                <button type="button" onClick={() => { void studio.copyAll(); setExportOpen(false); }}>Sao chép tất cả</button>
                <button type="button" onClick={() => { studio.download("numbered"); setExportOpen(false); }}>TXT số</button>
                <button type="button" onClick={() => { studio.download("flow"); setExportOpen(false); }}>Gói Flow</button>
                <button type="button" onClick={() => { studio.download("json"); setExportOpen(false); }}>JSON</button>
                <button type="button" onClick={() => { studio.download("csv"); setExportOpen(false); }}>CSV</button>
              </div>
            ) : null}
          </div>
          <button className="round" type="button" aria-label="Thông báo" title="Báo cáo" onClick={() => setReportOpen(true)}><Bell size={14} /></button>
          <button className="avatar" type="button" aria-label="Hồ sơ" title="Hồ sơ">T</button>
          <button id="theme" type="button" aria-label="Đổi giao diện" title="Đổi nền" onClick={() => studio.setTheme(studio.theme === "dark" ? "light" : "dark")}>
            {studio.theme === "dark" ? <Moon size={14} /> : <Sun size={14} />}
          </button>
        </div>
      </header>
      <main
        className={studio.scenes.length ? (collapsed ? "collapsed" : undefined) : "empty"}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); if (event.dataTransfer.files.length) takeFiles(event.dataTransfer.files); }}
      >
        <nav className="rail" aria-label="Điều hướng">
          <button type="button" title="Trang chủ" onClick={() => { setCollapsed(false); setListFilter("all"); }}><House /></button>
          <button className="primary" type="button" title="Danh sách cảnh" onClick={() => setCollapsed(false)}><LayoutGrid /></button>
          <button type="button" title="Báo cáo" onClick={() => setReportOpen(true)}><BarChart3 /></button>
          <button type="button" title="Mở tệp" onClick={openFile}><Folder /></button>
          <button type="button" title="Cài đặt" onClick={() => studio.setSettingsOpen(true)}><Settings /></button>
          <button className="collapse" type="button" title={collapsed ? "Mở danh sách" : "Thu danh sách"} onClick={() => setCollapsed((value) => !value)}><ChevronRight /></button>
        </nav>
        {studio.scenes.length > 0 ? <section className="overview card">
          <div className="project"><span className="stat-icon"><FileText /></span><div><b>Tổng quan dự án</b><small>{studio.fileName || "Chưa mở file"}</small></div></div>
          <div className="stat"><span className="stat-icon"><LayoutGrid /></span><div><b>{studio.scenes.length}</b><small>Tổng số cảnh</small></div></div>
          <div className="stat"><span className="stat-icon done"><Check /></span><div><b>{counts.done}</b><small>Đã hoàn thành</small></div></div>
          <div className="stat"><span className="stat-icon"><Clock /></span><div><b>{counts.waiting}</b><small>Đang chờ</small></div></div>
          <div className="stat"><span className="stat-icon warn"><AlertTriangle /></span><div><b>{counts.review}</b><small>Cần kiểm tra</small></div></div>
          <div className="ring">{counts.pct}%</div>
          <div className="saved"><Cloud /> {savedLabel.startsWith("Đã lưu") ? "Đã lưu tự động" : savedLabel}<small>{savedLabel.startsWith("Đã lưu") ? savedLabel.replace("Đã lưu ", "") : ""}</small></div>
        </section> : null}
        {studio.scenes.length === 0 ? (
          <section className="empty-screen">
            <article className="card empty-card">
              <span className="logo" aria-hidden="true"><Play size={16} fill="currentColor" strokeWidth={0} /></span>
              <h1>Mở kịch bản</h1>
              <p>Thả file .srt hoặc .txt vào đây. Mỗi cảnh sẽ có một prompt tiếng Anh cho Google Flow.</p>
              <label className={dragOver ? "drop over" : "drop"} onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={(event) => { event.preventDefault(); setDragOver(false); if (event.dataTransfer.files.length) takeFiles(event.dataTransfer.files); }}>
                <Upload /> Thả file vào đây
                <input type="file" accept=".srt,.txt,text/plain" onChange={(event) => { if (event.target.files) takeFiles(event.target.files); }} />
              </label>
              <div className="paging">
                <button type="button" onClick={openFile}>Chọn file</button>
                <button className="primary" type="button" onClick={() => void studio.loadSample()}>Mở file mẫu</button>
              </div>
              {studio.resumeOffer ? <p>Có bản lưu {new Date(studio.resumeOffer.savedAt).toLocaleString("vi-VN")}.</p> : null}
            </article>
          </section>
        ) : null}
        {studio.scenes.length > 0 ? <aside className="scenes card">
          <div className="search">
            <input id="search" placeholder="Tìm cảnh hoặc lời thoại…" value={query} aria-label="Tìm cảnh" onChange={(event) => setQuery(event.target.value)} />
            <button type="button" aria-label="Bộ lọc" onClick={() => setListFilter("all")}><SlidersHorizontal /></button>
          </div>
          <div className="tabs">
            <button type="button" className={listFilter === "all" ? "primary" : undefined} onClick={() => setListFilter("all")}>Tất cả ({studio.scenes.length})</button>
            <button type="button" className={listFilter === "done" ? "primary" : undefined} onClick={() => setListFilter("done")}>Đã xong ({counts.done})</button>
            <button type="button" className={listFilter === "waiting" ? "primary" : undefined} onClick={() => setListFilter("waiting")}>Đang chờ ({counts.waiting})</button>
            <button type="button" className={listFilter === "review" ? "primary" : undefined} onClick={() => setListFilter("review")}>Cần kiểm tra ({counts.review})</button>
          </div>
          <div id="list">
            {visibleScenes.map((scene) => {
              const row = studio.results.find((item) => item.sceneId === scene.sceneId);
              const active = scene.sceneId === selected?.sceneId;
              return (
                <button key={scene.sceneId} type="button" className={active ? "scene active" : "scene"} onClick={() => setSelectedId(scene.sceneId)}>
                  <span className="dot" />
                  <b>#{scene.sceneId}</b>
                  <span>{dashRange(scene.timeRange) || scene.title}</span>
                  <span className="pill">{BUCKET_LABEL[bucket(row?.status)]}</span>
                </button>
              );
            })}
          </div>
        </aside> : null}
        {studio.scenes.length > 0 ? <section className="workspace">
          {selected ? (
            <SceneWorkspace
              studio={studio}
              sceneId={selected.sceneId}
              title={selected.cutReason || selected.title}
              source={selected.source}
              timeRange={dashRange(selected.timeRange)}
              index={selectedIndex}
              total={studio.scenes.length}
              result={selectedResult}
              images={images}
              prompt={drafts[selected.sceneId] ?? (selectedResult?.prompt || (selected.sceneId === "001" && new URLSearchParams(window.location.search).has("fixture") ? FIXTURE_PROMPT : ""))}
              onPrompt={(value) => {
                setDrafts((current) => ({ ...current, [selected.sceneId]: value }));
                setSaveState("unsaved");
              }}
              onPrev={() => selectedIndex > 0 && setSelectedId(studio.scenes[selectedIndex - 1].sceneId)}
              onNext={() => selectedIndex < studio.scenes.length - 1 && setSelectedId(studio.scenes[selectedIndex + 1].sceneId)}
              onCopy={copyText}
              onSaved={(ok) => { setSaveState(ok ? "saved" : "failed"); if (ok) setSavedAt(Date.now()); }}
              onAddImages={() => imageRef.current?.click()}
              onRemoveImage={(index) => removeImage(selected.sceneId, index)}
              confirmClear={confirmClear}
              setConfirmClear={setConfirmClear}
            />
          ) : null}
        </section> : null}
      </main>
      <input ref={imageRef} type="file" accept="image/*" multiple onChange={(event) => { if (event.target.files && selected) void addImages(selected.sceneId, [...event.target.files]); event.target.value = ""; }} />
      <div id="toast" role="status" style={{ display: notice || studio.toast || studio.error ? "block" : "none" }}>{studio.error || notice || studio.toast}</div>
      {reportOpen ? <ReportDialog studio={studio} counts={counts} onClose={() => setReportOpen(false)} /> : null}
      {studio.settingsOpen ? <SettingsDrawer studio={studio} onClose={() => studio.setSettingsOpen(false)} /> : null}
      {studio.resumeOffer ? (
        <div className="restore" role="dialog" aria-label="Khôi phục bản lưu">
          <p>Có bản lưu {new Date(studio.resumeOffer.savedAt).toLocaleString("vi-VN")} của {studio.resumeOffer.fileName}.</p>
          <button className="primary" type="button" onClick={() => studio.applyCheckpoint(studio.resumeOffer!)}>Tiếp tục</button>
          <button type="button" onClick={studio.dismissResume}>Bỏ</button>
        </div>
      ) : null}
    </>
  );
}

function SceneWorkspace({
  studio, sceneId, title, source, timeRange, index, total, result, images, prompt, onPrompt, onPrev, onNext, onCopy, onSaved, onAddImages, onRemoveImage, confirmClear, setConfirmClear,
}: {
  studio: ReturnType<typeof useStudio>;
  sceneId: string;
  title: string;
  source: string;
  timeRange?: string;
  index: number;
  total: number;
  result?: SceneResult;
  images: string[];
  prompt: string;
  onPrompt: (value: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onCopy: (value: string) => void;
  onSaved: (ok: boolean) => void;
  onAddImages: () => void;
  onRemoveImage: (index: number) => void;
  confirmClear: boolean;
  setConfirmClear: (value: boolean) => void;
}) {
  const [photo, setPhoto] = useState(0);
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    setPhoto(0);
  }, [sceneId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        try {
          studio.saveEdit(sceneId, { title, environment: result?.environment || "", prompt, cast: result?.visibleCast.join(", ") || "" });
          onSaved(true);
        } catch {
          onSaved(false);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [studio, sceneId, title, prompt, result?.environment, result?.visibleCast, onSaved]);

  const styleId = STYLES.find((item) => item.footer === studio.settings.footer)?.id ?? "cinematic";
  const shown = prompt ? wrapPrompt(prompt, studio.settings.prefix, studio.settings.footer) : "";
  const status = bucket(result?.status);
  const src = images[Math.min(photo, Math.max(0, images.length - 1))];

  return (
    <>
      <div className="scene-head">
        <div>
          <small id="time">{timeRange || "Cảnh"}</small>
          <h1 id="title">#{sceneId} {title}</h1>
        </div>
        <div className="paging">
          <button id="prev" type="button" onClick={onPrev} disabled={index <= 0}><ChevronLeft /> Cảnh trước</button>
          <span id="page">{index + 1} / {total}</span>
          <button id="next" type="button" onClick={onNext} disabled={index >= total - 1}>Cảnh sau <ChevronRight /></button>
        </div>
      </div>
      <div className={images.length ? "editor-grid" : "editor-grid solo"}>
        <div className="editors">
          <article className="card editor">
            <div className="editor-head">
              <span className="accent"><FileText /></span>
              <b>Lời thoại gốc <span>(Tiếng Anh)</span></b>
              <span className="tag">SRT</span>
              <button className="mini" id="copySpeech" type="button" aria-label="Sao chép lời thoại" onClick={() => onCopy(source)}><Copy /></button>
            </div>
            <div className="field">
              <textarea id="speech" readOnly value={source} />
              <small id="speechCount">{source.length.toLocaleString("vi-VN")} / 1.000</small>
            </div>
          </article>
          <article className="card editor prompt">
            <div className="editor-head">
              <span className="accent"><Sparkles /></span>
              <b>Prompt <span>(Tiếng Anh)</span></b>
              <select
                id="style"
                aria-label="Phong cách"
                value={styleId}
                onChange={(event) => {
                  const next = STYLES.find((item) => item.id === event.target.value) ?? STYLES[0];
                  studio.setSettings({ ...studio.settings, prefix: next.prefix, footer: next.footer });
                }}
              >
                {STYLES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
              <button className="mini" id="copyPrompt" type="button" aria-label="Sao chép prompt" onClick={() => onCopy(shown || prompt)}><Copy /></button>
            </div>
            <div className="field">
              <textarea id="prompt" placeholder="Chưa có prompt. Bấm Viết lại prompt để tạo từ lời thoại." value={prompt} onChange={(event) => onPrompt(event.target.value)} />
              <small id="promptCount">{prompt.length.toLocaleString("vi-VN")} / 2.000</small>
            </div>
          </article>
        </div>
        <article className="card gallery" hidden={images.length === 0}>
          <div className="photo">
            {src ? <img id="photo" src={src} alt="Ảnh minh họa cảnh" /> : null}
            <span className="photo-label">Ảnh minh họa</span>
            <button id="expand" type="button" aria-label="Mở rộng ảnh" title="Mở rộng" onClick={() => setZoom(true)}><Maximize2 /></button>
            <button className="remove-still" type="button" title="Xóa ảnh này" onClick={() => onRemoveImage(photo)}>×</button>
          </div>
          <div className="thumbs">
            <button id="imagePrev" type="button" aria-label="Ảnh trước" onClick={() => setPhoto((value) => (value + images.length - 1) % images.length)}><ChevronLeft /></button>
            <div id="thumbList">
              {images.map((item, thumb) => (
                <button key={`${thumb}-${item}`} type="button" className={thumb === photo ? "active" : undefined} onClick={() => setPhoto(thumb)}>
                  <img src={item} alt={`Ảnh ${thumb + 1}`} />
                </button>
              ))}
            </div>
            <button id="imageNext" type="button" aria-label="Ảnh sau" title="Ảnh sau" onClick={() => setPhoto((value) => (value + 1) % images.length)}><ChevronRight /></button>
          </div>
        </article>
      </div>
      <div className="actions">
        <button className="primary" id="rewrite" type="button" title="Viết lại prompt cảnh này" disabled={studio.phase === "running"} onClick={() => void studio.run(studio.lastMode, { only: [sceneId], prior: studio.results.map((item) => item.sceneId === sceneId ? { ...item, status: "pending", attempts: 0 } : item) })}><Sparkles /> Viết lại prompt</button>
        <button id="copy" type="button" title="Sao chép prompt" onClick={() => onCopy(shown || prompt)}><Copy /> Sao chép</button>
        <button id="clear" type="button" title="Xóa nội dung prompt" onClick={() => setConfirmClear(true)}><Trash2 /> Xóa nội dung</button>
        <button type="button" title="Thêm ảnh cho cảnh này" onClick={onAddImages}><ImagePlus /> Thêm ảnh</button>
        <div className="spacer" />
        <label>Trạng thái:
          <select id="status" value={status} aria-label="Trạng thái" onChange={() => undefined}>
            <option value="waiting">Đang chờ</option>
            <option value="done">Đã xong</option>
            <option value="review">Cần kiểm tra</option>
          </select>
        </label>
        <button className="primary" id="save" type="button" title="Lưu (Ctrl+S)" onClick={() => { try { studio.saveEdit(sceneId, { title, environment: result?.environment || "", prompt, cast: result?.visibleCast.join(", ") || "" }); onSaved(true); } catch { onSaved(false); } }}><Check /> Lưu (Ctrl + S)</button>
      </div>
      {confirmClear ? (
        <dialog open>
          <p>Xóa nội dung prompt của cảnh này?</p>
          <button type="button" onClick={() => { onPrompt(""); setConfirmClear(false); }}>Xóa</button>
          <button type="button" onClick={() => setConfirmClear(false)}>Giữ lại</button>
        </dialog>
      ) : null}
      {zoom && src ? (
        <dialog id="lightbox" open onClick={() => setZoom(false)}>
          <button id="close" type="button" onClick={() => setZoom(false)}>Đóng ×</button>
          <img id="large" src={src} alt="Ảnh phóng to" />
        </dialog>
      ) : null}
    </>
  );
}

function ReportDialog({ studio, counts, onClose }: { studio: ReturnType<typeof useStudio>; counts: { done: number; review: number; waiting: number; pct: number }; onClose: () => void }) {
  const report = studio.report;
  return (
    <div className="scrim" onClick={onClose} role="presentation">
      <dialog className="report" open onClick={(event) => event.stopPropagation()}>
        <button type="button" onClick={onClose}>Đóng ×</button>
        <h2>Báo cáo</h2>
        {!report ? <p>Chưa có lượt chạy. Mô phỏng không gọi API.</p> : (
          <>
            <p>{studio.lastMode === "mock" ? "Báo cáo mô phỏng." : "Báo cáo lượt chạy."}</p>
            <p>Đạt {counts.pct}% · {report.requests} request · {report.rejectionEvents} lần loại</p>
            <p>{report.tokens.total.toLocaleString("vi-VN")} token</p>
          </>
        )}
      </dialog>
    </div>
  );
}

function SettingsDrawer({ studio, onClose }: { studio: ReturnType<typeof useStudio>; onClose: () => void }) {
  const settings = studio.settings;
  const set = studio.setSettings;
  return (
    <div className="scrim" onClick={onClose} role="presentation">
      <aside className="drawer" role="dialog" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
        <div className="editor-head"><h2 id="settings-title">Cài đặt</h2><button type="button" onClick={onClose}>Đóng</button></div>
        <p>Khóa chỉ nằm trên trình duyệt này.</p>
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
