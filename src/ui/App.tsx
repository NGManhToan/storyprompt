import { useEffect, useState } from "react";
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
  const [dragOver, setDragOver] = useState(false);
  const [wrapped, setWrapped] = useState(true);
  const usable = studio.results.some((row) => row.prompt && (row.status === "accepted" || row.status === "edited"));
  const continueRun = studio.results.some((row) => row.status === "accepted" || row.status === "edited");

  return (
    <>
      <div className="mesh" aria-hidden="true" />
      <div className="app">
        <header className="top">
          <a className="brand" href="#top">
            <span className="mark" aria-hidden="true" />
            <span>
              <strong>StoryPrompt</strong>
              <small>Web · Google Flow</small>
            </span>
          </a>
          <div className="top-actions">
            <button className="icon-btn" type="button" onClick={() => studio.setTheme(studio.theme === "dark" ? "light" : "dark")} aria-label={studio.theme === "dark" ? "Chuyển giao diện sáng" : "Chuyển giao diện tối"}>
              <ThemeIcon dark={studio.theme === "dark"} />
            </button>
            <button className="btn" type="button" onClick={() => studio.setGuideOpen(true)}>
              Hướng dẫn
            </button>
            <button className="btn" type="button" onClick={() => studio.setSettingsOpen(true)}>
              Cài đặt
            </button>
          </div>
        </header>

        <div className="shell" id="top">
          <aside className="panel side">
            <p className="eyebrow">Kịch bản .srt</p>
            <label
              className={dragOver ? "drop over" : "drop"}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                const file = event.dataTransfer.files?.[0];
                if (file) void studio.onFile(file);
              }}
            >
              <input
                type="file"
                accept=".srt,.txt,text/plain"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void studio.onFile(file);
                }}
              />
              <span className="drop-title">{studio.fileName || "Thả file phụ đề vào đây"}</span>
              <span className="drop-copy">Một cảnh một prompt tiếng Anh, khoảng 28–42 từ. File không rời khỏi máy cho đến khi bạn chạy.</span>
            </label>
            <button className="btn ghost wide" type="button" onClick={() => void studio.loadSample()}>
              Tải file mẫu 20 cảnh
            </button>
            {studio.scenes.length ? (
              <div className="cut-controls">
                <div className="filters">
                  {(
                    [
                      ["headings", "Theo cảnh"],
                      ["fixed", `${studio.duration}s`],
                      ["sense", "Cụm nghĩa"],
                    ] as const
                  ).map(([mode, text]) => (
                    <button
                      key={mode}
                      type="button"
                      className={studio.chunkMode === mode ? "pill on" : "pill"}
                      onClick={() => studio.recut(mode, studio.duration)}
                    >
                      {text}
                    </button>
                  ))}
                </div>
                <label>
                  Nhịp cảnh
                  <select
                    value={studio.duration}
                    onChange={(event) => studio.recut(studio.chunkMode === "headings" ? "fixed" : studio.chunkMode, Number(event.target.value))}
                  >
                    {[4, 6, 8, 10, 12].map((seconds) => (
                      <option key={seconds} value={seconds}>
                        {seconds} giây
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}
            <label>
              Kịch bản gốc
              <textarea
                rows={4}
                value={studio.masterScript}
                placeholder="Dán kịch bản đầy đủ nếu có. Mỗi lô sẽ nhận bản này để giữ không gian."
                onChange={(event) => studio.setMasterScript(event.target.value)}
              />
            </label>
            <label>
              Chủ đề
              <input
                value={studio.settings.topic}
                placeholder="Ví dụ: video essay buổi sáng"
                onChange={(event) => studio.setSettings({ ...studio.settings, topic: event.target.value })}
              />
            </label>
            <label>
              Tên người kể
              <input
                value={studio.settings.protagonist}
                placeholder="Để trống nếu không có người kể"
                onChange={(event) => studio.setSettings({ ...studio.settings, protagonist: event.target.value })}
              />
            </label>
            {studio.warnings.length ? (
              <ul className="notes">
                {studio.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}

            <div className="block">
              <div className="row-between">
                <h2>Nhân vật</h2>
                <span className="meta">{studio.knownNames.length}</span>
              </div>
              <p className="hint">Lấy từ lời thoại và lời dẫn. Chỉ người đang trong khung mới vào visible_cast.</p>
              <div className="chips">
                {studio.knownNames.map((name) => (
                  <button key={name} type="button" className="chip" onClick={() => studio.removeName(name)}>
                    {name}
                    <span aria-hidden="true">×</span>
                  </button>
                ))}
                {!studio.knownNames.length ? <span className="hint">Chưa có tên.</span> : null}
              </div>
              <NameField onAdd={studio.addName} />
            </div>

            <label className="switch">
              <input
                type="checkbox"
                checked={studio.settings.bible}
                onChange={(event) => studio.setSettings({ ...studio.settings, bible: event.target.checked })}
              />
              <span>Story bible</span>
            </label>
            <p className="hint">Bật để khóa ánh sáng theo địa điểm. Cấu trúc prompt sẽ đổi, nên mặc định tắt.</p>

            <dl className="facts">
              <div>
                <dt>Mô hình</dt>
                <dd>{studio.settings.geminiModel}</dd>
              </div>
              <div>
                <dt>Lô / luồng</dt>
                <dd>
                  {studio.settings.batchSize} · {studio.settings.concurrency}
                </dd>
              </div>
              <div>
                <dt>Hôm nay</dt>
                <dd>
                  {studio.usage.dayKey === studio.dayKey ? studio.usage.count : 0}/{studio.settings.rpd} req
                </dd>
              </div>
              <div>
                <dt>Server</dt>
                <dd>{studio.health?.gemini ? "Gemini sẵn" : studio.health ? "Chưa có khóa server" : "Chạy trực tiếp"}</dd>
              </div>
            </dl>
          </aside>

          <main className="panel main">
            {!studio.scenes.length ? <Hero onSample={() => void studio.loadSample()} /> : null}
            {studio.scenes.length ? (
              <>
                <div className="stage-head">
                  <div>
                    <p className="eyebrow">{studio.fileName}</p>
                    <h1>
                      {studio.scenes.length} cảnh
                      <span> {studio.label}</span>
                    </h1>
                  </div>
                  <div className="meters">
                    <Meter label="Tiến độ" value={`${studio.doneCount}/${studio.scenes.length}`} />
                    <Meter label="Thời gian" value={formatMs(studio.elapsed)} />
                    <Meter label="Đạt" value={studio.report ? `${studio.report.acceptedPct}%` : "—"} />
                  </div>
                </div>
                <div className="track" aria-hidden="true">
                  <span style={{ width: `${studio.scenes.length ? (studio.doneCount / studio.scenes.length) * 100 : 0}%` }} />
                </div>
                {studio.error ? <p className="banner bad">{studio.error}</p> : null}
                {studio.resumeOffer ? (
                  <div className="banner">
                    <p>
                      Có bản lưu {new Date(studio.resumeOffer.savedAt).toLocaleString("vi-VN")} với{" "}
                      {studio.resumeOffer.results.filter((row) => row.status === "accepted" || row.status === "edited").length} cảnh đã xong.
                    </p>
                    <div className="row">
                      <button className="btn small" type="button" onClick={() => studio.applyCheckpoint(studio.resumeOffer!)}>
                        Tiếp tục
                      </button>
                      <button className="btn ghost small" type="button" onClick={studio.dismissResume}>
                        Bỏ
                      </button>
                    </div>
                  </div>
                ) : null}
                {studio.phase === "running" && modeIsMock(studio.label) ? (
                  <p className="hint">Mô phỏng không gọi API. Prompt mẫu dùng để kiểm tra validator, retry và báo cáo.</p>
                ) : null}

                <div className="filters">
                  {(
                    [
                      ["all", "Tất cả"],
                      ["accepted", "Đạt"],
                      ["attention", "Cần xem"],
                    ] as const
                  ).map(([id, text]) => (
                    <button key={id} type="button" className={studio.filter === id ? "pill on" : "pill"} onClick={() => studio.setFilter(id)}>
                      {text}
                    </button>
                  ))}
                  <button type="button" className={wrapped ? "pill on" : "pill"} onClick={() => setWrapped((value) => !value)}>
                    {wrapped ? "Bản gửi Flow" : "Prompt gốc"}
                  </button>
                </div>

                <div className="scene-table" role="table">
                  <div className="scene head" role="row">
                    <span>Cảnh</span>
                    <span>Nguồn</span>
                    <span>Prompt</span>
                    <span>Diễn viên</span>
                    <span>Trạng thái</span>
                  </div>
                  {studio.scenes
                    .filter((scene) => {
                      const row = studio.results.find((item) => item.sceneId === scene.sceneId);
                      if (studio.filter === "accepted") return row?.status === "accepted" || row?.status === "edited";
                      if (studio.filter === "attention") return row && row.status !== "accepted" && row.status !== "pending";
                      return true;
                    })
                    .map((scene, index) => {
                      const row = studio.results.find((item) => item.sceneId === scene.sceneId);
                      return (
                        <SceneRow
                          key={scene.sceneId}
                          index={index}
                          source={scene.source}
                          title={scene.title}
                          timeRange={scene.timeRange}
                          row={row}
                          editing={studio.editing === scene.sceneId}
                          wrapped={wrapped}
                          prefix={studio.settings.prefix}
                          footer={studio.settings.footer}
                          onEdit={() => studio.setEditing(scene.sceneId)}
                          onCancel={() => studio.setEditing(null)}
                          onSave={(patch) => studio.saveEdit(scene.sceneId, patch)}
                          onRegen={() =>
                            void studio.run(studio.lastMode, {
                              only: [scene.sceneId],
                              prior: studio.results.map((item) =>
                                item.sceneId === scene.sceneId
                                  ? { ...item, status: "pending", attempts: 0, prompt: "", rejections: [] }
                                  : item,
                              ),
                            })
                          }
                        />
                      );
                    })}
                </div>

                <Report report={studio.report} logs={studio.logs} bibleOn={studio.settings.bible} />
              </>
            ) : null}
          </main>
        </div>

        {studio.scenes.length ? (
          <div className="dock">
            <button className="btn primary" type="button" disabled={studio.phase === "running"} onClick={() => void studio.run("mock", { fresh: !continueRun })}>
              {continueRun ? "Mô phỏng tiếp" : "Chạy mô phỏng"}
            </button>
            <button className="btn" type="button" disabled={studio.phase === "running"} onClick={() => void studio.run("live", { fresh: !continueRun })}>
              {continueRun ? "Chạy tiếp" : "Chạy thật"}
            </button>
            {continueRun ? (
              <button className="btn ghost" type="button" disabled={studio.phase === "running"} onClick={() => void studio.run("live", { fresh: true })}>
                Viết lại
              </button>
            ) : null}
            {studio.phase === "running" ? (
              <button className="btn danger" type="button" onClick={studio.stop}>
                Dừng
              </button>
            ) : null}
            <span className="dock-gap" />
            <button className="btn" type="button" disabled={!usable} onClick={() => void studio.copyAll()}>
              Sao chép
            </button>
            <button className="btn" type="button" disabled={!usable} onClick={() => studio.download("json")}>
              JSON
            </button>
            <button className="btn" type="button" disabled={!usable} onClick={() => studio.download("txt")}>
              TXT
            </button>
            <button className="btn" type="button" disabled={!usable} onClick={() => studio.download("flow")}>
              Gói Flow
            </button>
            <button className="btn" type="button" disabled={!usable} onClick={() => studio.download("numbered")}>
              TXT số
            </button>
            <button className="btn" type="button" disabled={!usable} onClick={() => studio.download("csv")}>
              CSV
            </button>
          </div>
        ) : null}
      </div>

      {studio.guideOpen ? <Guide onClose={() => studio.setGuideOpen(false)} /> : null}
      {studio.settingsOpen ? <SettingsDrawer studio={studio} onClose={() => studio.setSettingsOpen(false)} /> : null}
      {studio.toast ? <div className="toast">{studio.toast}</div> : null}
    </>
  );
}

function modeIsMock(label: string) {
  return label.toLowerCase().includes("mô phỏng");
}

function Hero({ onSample }: { onSample: () => void }) {
  return (
    <section className="hero">
      <p className="eyebrow">Prompt hình cho từng cảnh</p>
      <h1>
        Mỗi cảnh,
        <br />
        một khung hình.
      </h1>
      <p className="lede">
        Đọc phụ đề kịch bản và viết một prompt tiếng Anh cho Google Flow. Ngoại hình để ảnh tham chiếu. Việc nặng nằm ở API miễn phí, không phải GPU của bạn.
      </p>
      <div className="hero-grid">
        <article>
          <span>01</span>
          <h2>Lô nhỏ, có ngữ cảnh</h2>
          <p>4–8 cảnh mỗi request. Cảnh kề bên đi kèm và bị đánh dấu chỉ đọc, để hành động không bị vay mượn.</p>
        </article>
        <article>
          <span>02</span>
          <h2>Loại trước khi nhận</h2>
          <p>Diễn viên có mặt, câu cụt, tiếng Việt lẫn, chữ trên hình, trùng cảnh. Hàng lỗi được viết lại riêng.</p>
        </article>
        <article>
          <span>03</span>
          <h2>Dừng giữa chừng vẫn còn</h2>
          <p>Checkpoint nằm trên trình duyệt. Báo cáo ghi thời gian đo được, token và lý do loại.</p>
        </article>
      </div>
      <button className="btn primary" type="button" onClick={onSample}>
        Xem kịch bản mẫu
      </button>
    </section>
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

function NameField({ onAdd }: { onAdd: (name: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="add-name"
      onSubmit={(event) => {
        event.preventDefault();
        onAdd(value);
        setValue("");
      }}
    >
      <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Thêm tên" aria-label="Thêm tên nhân vật" />
      <button className="btn small" type="submit">
        Thêm
      </button>
    </form>
  );
}

function SceneRow({
  index,
  source,
  title,
  timeRange,
  row,
  editing,
  wrapped,
  prefix,
  footer,
  onEdit,
  onCancel,
  onSave,
  onRegen,
}: {
  index: number;
  source: string;
  title: string;
  timeRange?: string;
  row?: SceneResult;
  editing: boolean;
  wrapped: boolean;
  prefix: string;
  footer: string;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (patch: { title: string; environment: string; prompt: string; cast: string }) => void;
  onRegen: () => void;
}) {
  const [draft, setDraft] = useState({
    title: row?.title || title,
    environment: row?.environment || "",
    prompt: row?.prompt || "",
    cast: row?.visibleCast.join(", ") || "",
  });
  useEffect(() => {
    if (!editing) return;
    setDraft({
      title: row?.title || title,
      environment: row?.environment || "",
      prompt: row?.prompt || "",
      cast: row?.visibleCast.join(", ") || "",
    });
  }, [editing, row?.title, row?.environment, row?.prompt, row?.visibleCast, title]);
  const shown = row?.prompt ? (wrapped ? wrapPrompt(row.prompt, prefix, footer) : row.prompt) : "";
  return (
    <article className={`scene ${row?.status ?? "pending"}`} style={{ ["--i" as string]: String(Math.min(index, 12)) }} role="row">
      <div>
        <b>{row?.sceneId}</b>
        <small>{timeRange || row?.title || title}</small>
      </div>
      <p className="source">{source}</p>
      <div>
        {editing ? (
          <form
            className="edit"
            onSubmit={(event) => {
              event.preventDefault();
              onSave(draft);
            }}
          >
            <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} aria-label="Tiêu đề" />
            <input value={draft.environment} onChange={(event) => setDraft({ ...draft, environment: event.target.value })} aria-label="Bối cảnh" placeholder="Bối cảnh" />
            <textarea value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} aria-label="Prompt" rows={4} />
            <input value={draft.cast} onChange={(event) => setDraft({ ...draft, cast: event.target.value })} aria-label="Diễn viên" placeholder="Lan, Minh" />
            <div className="row">
              <button className="btn small" type="submit">
                Lưu
              </button>
              <button className="btn ghost small" type="button" onClick={onCancel}>
                Hủy
              </button>
              <span className="meta">{countWords(draft.prompt)} từ</span>
            </div>
          </form>
        ) : (
          <>
            <p className={shown ? "prompt" : "prompt empty"}>{shown || "Chưa có prompt."}</p>
            {row?.cameraAngle ? (
              <span className="meta">
                {row.shotSequence ? `${row.shotSequence} · ` : ""}
                {row.cameraAngle}
              </span>
            ) : null}
            {row?.prompt ? <span className="meta">{countWords(row.prompt)} từ gốc</span> : null}
            {row?.rejections.length ? (
              <ul className="reasons">
                {row.rejections.map((reason) => (
                  <li key={reason.code}>{reason.detail}</li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
      <div className="chips slim">
        {(row?.visibleCast ?? []).map((name) => (
          <span key={name} className="chip static">
            {name}
          </span>
        ))}
      </div>
      <div className="status-col">
        <span className={`status ${row?.status ?? "pending"}`}>{STATUS_LABEL[row?.status ?? "pending"]}</span>
        {row && row.attempts > 1 ? <small>lần {row.attempts}</small> : null}
        <div className="row">
          <button className="btn tiny" type="button" onClick={onEdit}>
            Sửa
          </button>
          <button className="btn tiny" type="button" onClick={onRegen}>
            Viết lại
          </button>
        </div>
      </div>
    </article>
  );
}

function Report({
  report,
  logs,
  bibleOn,
}: {
  report: ReturnType<typeof useStudio>["report"];
  logs: ReturnType<typeof useStudio>["logs"];
  bibleOn: boolean;
}) {
  if (!report) {
    return (
      <section className="report empty-report">
        <h2>Báo cáo lượt chạy</h2>
        <p>Số đo xuất hiện sau khi chạy: tỉ lệ đạt, lý do loại, thời gian tường và token. Không có con số ước lượng trước.</p>
      </section>
    );
  }
  const reasons = Object.entries(report.rejectionsByReason).sort((a, b) => b[1] - a[1]);
  const max = reasons[0]?.[1] ?? 1;
  return (
    <section className="report">
      <div className="row-between">
        <h2>Báo cáo lượt chạy</h2>
        <span className="meta">{bibleOn ? "Có story bible" : "Không story bible"}</span>
      </div>
      <div className="stat-grid">
        <Meter label="Đạt" value={`${report.acceptedPct}%`} />
        <Meter label="Dùng được" value={`${report.usablePct}%`} />
        <Meter label="Thời gian tường" value={formatMs(report.wallTimeMs)} />
        <Meter label="Token" value={formatTokens(report.tokens.total)} />
        <Meter label="Request" value={String(report.requests)} />
        <Meter label="Lần loại" value={String(report.rejectionEvents)} />
      </div>
      <p className="hint">
        Thời gian {formatMs(report.wallTimeMs)} là số đo của lượt này
        {report.cancelled ? ", đã dừng giữa chừng" : ""}. Prompt vào {formatTokens(report.tokens.prompt)}, ra {formatTokens(report.tokens.output)}.
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
      ) : (
        <p className="hint">Không có lượt bị loại.</p>
      )}
      <details className="logs">
        <summary>Nhật ký request ({logs.length})</summary>
        <ul>
          {logs.map((log) => (
            <li key={log.id}>
              <b>{log.model}</b>
              <span>{log.finishReason}</span>
              <span>{log.totalTokens} token</span>
              <span>{log.latencyMs} ms</span>
              <span>{log.status}</span>
              <span>{log.rejections.map((item) => `${item.sceneId}:${item.reasons.join("+")}`).join(" ") || log.error || "ok"}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
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
          <button className="btn tiny" type="button" onClick={onClose}>
            Đóng
          </button>
        </div>
        <p className="hint">Khóa API chỉ nằm trong trình duyệt này. Server không ghi khóa ra đĩa.</p>
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
        <label>
          Gemini API key
          <input type="password" value={settings.geminiKey} autoComplete="off" onChange={(event) => set({ ...settings, geminiKey: event.target.value })} />
        </label>
        <label>
          Model Gemini
          <input value={settings.geminiModel} onChange={(event) => set({ ...settings, geminiModel: event.target.value })} />
        </label>
        <label>
          Model dự phòng
          <input value={settings.geminiFallbacks} onChange={(event) => set({ ...settings, geminiFallbacks: event.target.value })} />
        </label>
        <label>
          Groq API key
          <input type="password" value={settings.groqKey} autoComplete="off" onChange={(event) => set({ ...settings, groqKey: event.target.value })} />
        </label>
        <label>
          Model Groq
          <input value={settings.groqModel} onChange={(event) => set({ ...settings, groqModel: event.target.value })} />
        </label>
        <label>
          Cloudflare account id
          <input value={settings.cfAccount} onChange={(event) => set({ ...settings, cfAccount: event.target.value })} />
        </label>
        <label>
          Cloudflare API token
          <input type="password" value={settings.cfToken} autoComplete="off" onChange={(event) => set({ ...settings, cfToken: event.target.value })} />
        </label>
        <label>
          Model Cloudflare
          <input value={settings.cfModel} onChange={(event) => set({ ...settings, cfModel: event.target.value })} />
        </label>
        <div className="split">
          <label>
            Lô ({settings.batchSize})
            <input type="range" min={4} max={8} value={settings.batchSize} onChange={(event) => set({ ...settings, batchSize: Number(event.target.value) })} />
          </label>
          <label>
            Luồng ({settings.concurrency})
            <input type="range" min={1} max={6} value={settings.concurrency} onChange={(event) => set({ ...settings, concurrency: Number(event.target.value) })} />
          </label>
        </div>
        <div className="split">
          <label>
            RPM
            <input type="number" min={1} value={settings.rpm} onChange={(event) => set({ ...settings, rpm: Number(event.target.value) })} />
          </label>
          <label>
            TPM
            <input type="number" min={1} value={settings.tpm} onChange={(event) => set({ ...settings, tpm: Number(event.target.value) })} />
          </label>
          <label>
            RPD
            <input type="number" min={1} value={settings.rpd} onChange={(event) => set({ ...settings, rpd: Number(event.target.value) })} />
          </label>
        </div>
        <label>
          Số lần viết lại tối đa
          <input type="number" min={1} max={5} value={settings.maxAttempts} onChange={(event) => set({ ...settings, maxAttempts: Number(event.target.value) })} />
        </label>
        <label>
          maxOutputTokens
          <input type="number" min={1024} max={65536} step={256} value={settings.maxOutputTokens} onChange={(event) => set({ ...settings, maxOutputTokens: Number(event.target.value) })} />
        </label>
        <label>
          Tiền tố kiểu
          <input value={settings.prefix} onChange={(event) => set({ ...settings, prefix: event.target.value })} />
        </label>
        <label>
          Hậu tố
          <textarea rows={2} value={settings.footer} onChange={(event) => set({ ...settings, footer: event.target.value })} />
        </label>
        <label>
          Tên thêm, cách nhau bởi dấu phẩy
          <input value={settings.extraNames} onChange={(event) => set({ ...settings, extraNames: event.target.value })} />
        </label>
      </aside>
    </div>
  );
}

function Guide({ onClose }: { onClose: () => void }) {
  return (
    <div className="scrim center" onClick={onClose} role="presentation">
      <article className="guide" role="dialog" aria-labelledby="guide-title" onClick={(event) => event.stopPropagation()}>
        <div className="row-between">
          <h2 id="guide-title">Cách cắt cảnh và viết prompt</h2>
          <button className="btn tiny" type="button" onClick={onClose}>
            Đóng
          </button>
        </div>
        <section>
          <h3>1. Nhịp 8 giây hoặc theo tiêu đề cảnh</h3>
          <p>File có dòng CẢNH / INT / EXT thì giữ nguyên từng cảnh. Phụ đề thoại liên tục thì cắt cố định 8 giây (00:00–00:08, 00:08–00:16) hoặc theo cụm nghĩa, dừng ở dấu câu và khoảng lặng.</p>
        </section>
        <section>
          <h3>2. Tên khóa, không tả ngoại hình</h3>
          <p>Tên trong danh sách chỉ được gọi bằng tên. Ảnh tham chiếu của Flow giữ mặt, da, tóc và quần áo. Prompt không gắn ký tự đặc biệt trước tên và không ghi mã màu.</p>
        </section>
        <section>
          <h3>3. Đổi góc, cắt khi lời kể rời chỗ</h3>
          <p>Một không gian được khoảng ba đến bốn góc trước khi đổi chỗ: POV, chi tiết, trung cảnh, toàn cảnh. Nếu câu phụ đề kể một người đang làm việc ở nơi khác, hình cắt sang người đó. Tên chỉ được nhắc mà không có việc để vẽ thì không vào khung.</p>
        </section>
        <section>
          <h3>4. Kịch bản gốc và hậu kiểm</h3>
          <p>Mỗi lô nhận toàn bộ kịch bản để giữ không gian, còn cảnh kề bên bị đánh dấu chỉ đọc. Sau khi viết, hệ thống loại câu cụt, sai tiếng, chữ trên hình, trùng cảnh và diễn viên không có mặt, rồi viết lại từng cảnh.</p>
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
