# Pipeline nhanh, 0 đồng (nhánh `feat/fast-free-pipeline`)

Nhãn: **[ĐO]** đo trực tiếp · **[SUY RA]** tính từ số đo/tài liệu · **[CHƯA XÁC MINH]** chưa có số đo.

## Thay đổi chính

| Phần | Trước | Sau |
|---|---|---|
| Lane | 1 lane chính, lane khác chỉ là dự phòng tuần tự | Hàng đợi chung, mỗi lane có hạn mức riêng; lô chạy ở lane nào đang rảnh (`src/core/router.ts`) |
| Hạn mức | RPM/TPM/RPD dùng chung | Theo lane: Gemini RPM/TPM(input)/RPD · Groq RPM/TPM/**OTPM**/RPD · Cloudflare RPM + **dừng ở 9.000 neuron/ngày** (`src/core/scheduler.ts`, `laneLimits.ts`) |
| Gemini | `gemini-3.1-flash-lite → 3.8-flash → flash-latest`, chỉ đổi khi 404 | Chuỗi AI Studio `gemini-3.1-flash-lite → gemini-4-hydrogen`, lọc model nghỉ hưu, ngắt mạch 429→5', 503→2', 404→60', 401/403 dừng; stream có timeout token đầu 12 s / 25 s, vòng 2 thử unary, backoff `min(8s, 1s·2^n)+0–400ms` (`providers/gemini.ts`) |
| Schema | Mảng không giới hạn | `minItems = maxItems = số cảnh của lô`, `scene_id` là `enum` các id của lô; Gemini 4 thêm `thinkingLevel: LOW`; không gửi `maxOutputTokens`/`temperature` cho Gemini (như AI Studio) |
| Groq | `json_object`, `max_tokens = 8192` | `json_schema` (tự hạ về `json_object` nếu model từ chối), `reasoning_effort: none` cho qwen3, `max_tokens` theo lô (~220/cảnh + 96) |
| Cloudflare | `llama-3.1-8b`, không đếm neuron | `@cf/qwen/qwen3.8-27b`, `reasoning_effort: low`, `json_schema` (tự hạ nếu bị từ chối), đếm neuron theo bảng giá, dừng trước 10.000 |
| Ngữ cảnh | Tới 20.000 ký tự master script **mỗi lô** | Cửa sổ ±4 cảnh (≤3.600 ký tự); cảnh bên cạnh chỉ gửi tóm tắt 220 ký tự |
| Validator | Thiếu dấu chấm = loại; trùng `scene_id` = bỏ cả hai; JSON cụt = mất cả lô | Thêm dấu chấm khi câu không cụt; trùng thì giữ bản hợp lệ đầu tiên; `truncated` chỉ khi `finish_reason = length/MAX_TOKENS`; cứu hàng hoàn chỉnh trong JSON cụt; anchor cho phép lệch dấu câu (≥80% 3-gram) |
| Telemetry | Đếm lý do loại | Thêm: hàng trả/nhận theo lane, % nhận theo hàng, số phản hồi cắt cụt, hàng trùng, tự sửa kết câu, token output/cảnh đạt, neuron |
| Server | Không nạp `.env`; `npm start` hỏng trên Windows | Tự nạp `.env.local`/`.env` (không ghi đè biến có sẵn); `npm start` = `tsx server.ts --production` |

Quy tắc prompt (28–42 từ, tiếng Anh, webtoon, tên khóa, không chữ trên hình…) **giữ nguyên**.

## Hạn mức free dùng làm mặc định (đọc 27/11/2026)

| Lane | Số | Nguồn |
|---|---|---|
| Groq `qwen/qwen3.8-27b` | 30 RPM · 1K RPD · 8K TPM · 200K TPD | console.groq.com/docs/rate-limits |
| Groq OTPM | 1.000 output token/phút **[ĐO]** từ 429 thực tế (docs không công bố) | log live-60 bản C# |
| Cloudflare Workers AI | 10.000 neuron/ngày, reset 00:00 UTC; text-generation 300 RPM | developers.cloudflare.com/workers-ai/platform/pricing · /limits |
| Cloudflare qwen3.8-27b | 40.909 neuron/M input · 290.909 neuron/M output | trang pricing |
| Gemini free | **[CHƯA XÁC MINH]** Google chỉ hiện trong AI Studio → Rate limits. Mặc định an toàn 15 RPM · 250K TPM (input) · 500 RPD — chỉnh trong Cài đặt | ai.google.dev/gemini-api/docs/rate-limits |

Lưu ý dữ liệu: gói free của Gemini ghi "Used to improve our products: Yes" (ai.google.dev/pricing). Cloudflare qwen3.8-27b ghi Zero data retention.

## Chạy

```powershell
npm install
copy .env.example .env   # điền khóa nào có (GEMINI_API_KEY, GROQ_API_KEY, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN)
npm run dev              # web: http://localhost:47221
npm test; npm run typecheck; npm run build
npm run bench -- --mock --scenes 211            # mô phỏng, không gọi API
npm run bench -- --scenes 20 --lanes groq       # live nhỏ, chỉ dùng lane có khóa
npm run bench -- --scenes 60 --lanes gemini,groq,cloudflare
```

Kết quả bench ghi vào `bench-results/` (đã gitignore). Bench không in giá trị khóa.
