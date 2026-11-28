# StoryPrompt Web

Ứng dụng web biến file phụ đề kịch bản (`.srt`, thường 176–212 cảnh) thành **một prompt tiếng Anh cho mỗi cảnh**, dùng với Google Flow. Phần nặng chạy trên API miễn phí (Gemini, hoặc Groq / Cloudflare nếu bạn có khóa). Máy bạn không cài model, không dùng GPU.

Giao diện tiếng Việt. Prompt xuất ra là tiếng Anh.

## Chạy local

```bash
npm install
npm test
npm run dev
```

- Giao diện: http://127.0.0.1:47221
- API: http://127.0.0.1:47222

`npm test` dùng provider giả, không gọi API trả phí.

Khóa tùy chọn trong `.env` (xem `.env.example`) hoặc dán trong **Cài đặt**. Khóa dán trên giao diện chỉ nằm trong `localStorage` của trình duyệt.

### Quản lý khóa API (Cài đặt → Khóa API)

- Mỗi nhà cung cấp (Gemini, Groq, Cloudflare Workers AI) có danh sách khóa riêng. Bấm **＋ Thêm key mới** để thêm khóa (nhãn tuỳ chọn; Cloudflare cần thêm Account ID).
- Khóa hiển thị đã che (4 ký tự đầu + 4 ký tự cuối). Mỗi khóa có công tắc bật/tắt, nút **Kiểm tra** (gọi endpoint liệt kê model qua server cục bộ, không tốn token) và **Xoá**.
- Khóa trong `.env` hiện thành dòng **Từ server (.env)** chỉ đọc (chỉ thấy 4 ký tự cuối), vẫn bật/tắt và kiểm tra được.
- Mỗi khóa là một lane riêng với hạn mức, bộ đếm ngày và breaker 429 riêng. Khóa trước gặp 429 hoặc hết lượt ngày thì lô chuyển sang khóa kế tiếp.

## Cách dùng

1. Thả file `.srt`. Nếu file có dòng `CẢNH n` / `SCENE n` / `INT.` / `EXT.`, các cue được gom thành cảnh. Không có tiêu đề thì mỗi cue là một cảnh.
2. Kiểm tra tên nhân vật. Tên lấy từ người nói và các cách gọi như “ông Hải”, không hard-code.
3. **Chạy mô phỏng** để xem pipeline (validator, viết lại, báo cáo) mà không tốn quota.
4. **Chạy thật** khi đã có khóa. Lô 4–8 cảnh. Cảnh trước và sau đi kèm, đánh dấu chỉ đọc.
5. Sửa từng hàng hoặc bấm **Viết lại**. Bản lưu nằm trong IndexedDB, mở lại file là có thể tiếp tục.
6. **Sao chép**, **TXT**, **JSON**, hoặc **Gói Flow** (`storyprompt-flow-v1`: mỗi cảnh một `id` + `prompt`).

Story bible (địa điểm và ánh sáng ổn định) nằm sau công tắc. Tắt mặc định vì nó đổi cấu trúc prompt.

Ngoại hình không được mô tả trong prompt. Ảnh tham chiếu của Flow giữ mặt và trang phục. Hậu tố webtoon do code gắn thêm, không phải model.

## Phần lấy từ app AI Studio

App gốc cắt phụ đề thành cảnh khoảng 8 giây, gửi cả kịch bản mỗi lô, và viết prompt theo luật webtoon: đổi góc trong một không gian, cắt sang người đang được kể nếu câu đó mô tả việc của họ, không tả ngoại hình. StoryPrompt Web giữ các luật đó.

- Cắt **theo tiêu đề cảnh** khi file có `CẢNH` / `INT` / `EXT`. Nếu chỉ là phụ đề thoại: **cố định 4–12 giây** (mặc định 8) hoặc **cụm nghĩa**. TXT cắt theo dòng hoặc theo câu.
- Ô kịch bản gốc, chủ đề, tên người kể. Bật mặc định «Gửi toàn bộ kịch bản trong mỗi lô» (cắt ở 20.000 ký tự nếu quá dài).
- Lô mặc định 4. Nhiệt độ lượt đầu 0.7, lần viết lại 0.2. Model Gemini theo chuỗi của AI Studio: `gemini-3.1-flash-lite`, rồi `gemini-4-hydrogen` (xem `docs/FAST_FREE_PIPELINE.md`).
- Groq mặc định `qwen/qwen3.8-27b`, cùng họ model với làn chất lượng trong kế hoạch. Cloudflare vẫn nhập model tay.
- Mỗi cảnh có thêm góc máy, thứ tự shot và hành động ngắn. Xuất thêm `TXT số` (`1_prompt`) và CSV, bên cạnh gói Flow.
- Quá tải 503 không tự nhảy sang model khác. 429 chờ đúng hạn mức của model đang chạy.

Không mang sang: tên cứng trong prompt mẫu, luật gắn `@` và mã màu da cho bàn tay, nút tạo ảnh xem thử (model ảnh không có free tier ngoài AI Studio; ảnh vẫn là việc của Flow), và nhánh OpenAI trả phí.

## Hạn mức

Mặc định thận trọng, sửa trong Cài đặt cho đúng hạn mức khóa của bạn:

| | Mặc định |
| --- | --- |
| RPM | 15 |
| TPM | 250.000 |
| RPD | 500 |
| Lô | 4 |
| Luồng | 4 |
| Viết lại | 3 lần, từng cảnh một |
| maxOutputTokens | 8192 |

429 được chờ theo `retry-after`, rồi mới tăng dần. Bộ đếm request trong ngày nằm trên trình duyệt.

Với 211 cảnh, lô 6 là khoảng 36 request cho lượt đầu, cộng thêm các cảnh bị loại. Ở 15 RPM, sàn thời gian khoảng vài phút, chưa tính độ trễ và lần viết lại. Ứng dụng không hứa một con số. Báo cáo sau mỗi lượt ghi thời gian tường, token, tỉ lệ đạt và lý do loại.

Model Gemini mặc định: `gemini-3.1-flash-lite`, rồi `gemini-4-hydrogen` (giống app AI Studio). Model đã nghỉ hưu (`gemini-2.*`, `gemini-3.5-flash-lite`, `gemini-flash-latest`…) tự bị lọc. Lỗi 429 cho model nghỉ 5 phút, 503 nghỉ 2 phút, 404 nghỉ 60 phút; lúc đó lô chuyển sang Groq/Cloudflare nếu có khóa.

## Lane

Một giao diện chung, ba lane:

- **Gemini** — chính, free tier. Có thể gọi thẳng từ trình duyệt (tránh timeout 10 giây của Netlify) hoặc qua server nếu khóa nằm trong biến môi trường.
- **Groq** — API tương thích OpenAI. Thường cần proxy vì CORS.
- **Cloudflare Workers AI** — cần account id và token.

Lane sau chỉ được gọi khi lane trước lỗi (không phải 429). 429 ở lại lane hiện tại và chờ.

## Triển khai

### Netlify Free

Client tự chia lô, mỗi request là một lô ngắn. Function đồng bộ của Netlify khoảng 10 giây; lô dài nên bật **Gọi Gemini trực tiếp từ trình duyệt** và dán khóa của bạn.

1. Đẩy repo lên Git.
2. Netlify: build `npm run build`, publish `dist`. `netlify.toml` đã khai báo redirect `/api/*`.
3. Biến môi trường tùy chọn: `GEMINI_API_KEY`, `GROQ_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`. Không bắt buộc nếu mỗi người dùng dán khóa của mình.
4. Không dùng background function 15 phút cho cả kịch bản: checkpoint và tiến độ nằm trên trình duyệt, nên một lượt dài hơn 15 phút (quota thấp) vẫn chạy tiếp được.

### Cloud Run / Node

```bash
docker build -t storyprompt-web .
docker run -p 8080:8080 -e GEMINI_API_KEY=... storyprompt-web
```

Hoặc:

```bash
npm run build
npm start   # chạy được cả Windows PowerShell; tương đương tsx server.ts --production
```

Cloud Run:

```bash
gcloud run deploy storyprompt-web --source . --region asia-southeast1 --allow-unauthenticated --set-env-vars GEMINI_API_KEY=YOUR_KEY
```

Server đọc `PORT`. Khóa trong header của request chỉ dùng cho request đó, không ghi log, không ghi đĩa.

### Google AI Studio

App là Vite + React và `server.ts` (Node, gọi REST Gemini có stream + chuỗi dự phòng). Server tự nạp `.env.local` rồi `.env` (không ghi đè biến môi trường có sẵn). Chạy bằng `npm run dev` hoặc `npm start`. AI Studio inject `GEMINI_API_KEY`; health check sẽ báo Gemini sẵn và giao diện gọi `/api/generate` từng lô.

## Kiểm thử

```bash
npm test
npm run typecheck
```

- Parser SRT, validator, bộ điều phối RPM/TPM/RPD, backoff 429
- Viết lại cảnh sai ngôn ngữ / cảnh bị thiếu, dừng sau số lần tối đa, resume
- Một lượt giả lập 20 cảnh (`public/samples/nha-ben-song-20.srt`) ra đủ prompt và báo cáo

## Benchmark nên chạy với khóa thật

Làm lần lượt, đừng nhảy thẳng 211 cảnh:

1. **20 cảnh** — file mẫu hoặc 20 cảnh đầu. Xem tỉ lệ đạt, lý do loại, có bị cụt JSON không.
2. **60 cảnh** — xem RPM có phải là trần không, thời gian tường, số lần viết lại.
3. **211 cảnh** — chỉ khi 60 cảnh ổn. Giữ lô 4–6 nếu chất lượng tụt. So sánh một lần có story bible và một lần không.

Sau mỗi lượt, giữ báo cáo (JSON đầy đủ có `report` và `logs`).

## Giới hạn

- Hành động vay mượn được bắt bằng `source_anchor` (trích đúng cảnh) và cụm 4 từ tiếng Anh trùng cảnh kề. Không có bước dịch.
- Heuristic diễn viên dựa vào người nói, lời dẫn và các cách gọi “ông/bà/anh…”. Tên chỉ viết thường trong hành động, không phải người nói, cần thêm tay.
- “Đã rời / đi khuất / vắng mặt” mới coi là ra khỏi khung. Các cách diễn đạt khác có thể sót.
- Chưa có extension Chrome. Gói Flow là JSON một prompt mỗi cảnh.
- Quota free tier đổi theo tài khoản. Số mặc định là điểm xuất phát, không phải hạn mức chính thức của Google.


## Chạy nền (background job)

Bấm **Chạy** là server tự chạy cả lượt, không phụ thuộc trình duyệt: có thể đóng tab hoặc tắt trình duyệt, mở lại sẽ tự nối đúng lượt chạy (jobId lưu trong localStorage) và hiện "Xong lượt chạy" kèm tổng thời gian.

- `POST /api/jobs` (SRT/scenes + cài đặt + khóa từ trình duyệt nếu có) trả `{id}`; `GET /api/jobs`; `GET /api/jobs/:id[?rev=N]`; `POST /api/jobs/:id/cancel|resume`; `DELETE /api/jobs/:id`; `GET /api/jobs/:id/export?kind=flowsheet|json|…`.
- Trạng thái và kết quả lưu ở thư mục `jobs/` (đã gitignore). Khóa API không bao giờ ghi ra đĩa; server khởi động lại thì job dùng khóa `.env` tự chạy tiếp, job dùng khóa từ trình duyệt chuyển sang "Bị ngắt" và cần bấm "Chạy tiếp".
- Lane mặc định: Gemini chính, Cloudflare dự phòng (chỉ nhận lô khi Gemini phải chờ > 20 giây), Groq tắt.
- Lịch sử chạy: nút đồng hồ ở thanh trái.
## Mở cho máy khác bằng một đường link (Cloudflare Tunnel, miễn phí)

```
npm run share        # hoặc nhấp đúp share.cmd
```

- Lệnh này chạy một **cổng đăng nhập** ở `127.0.0.1:47231` đặt trước server `47230` (không động tới server hay Chrome của Flow) và một **Quick Tunnel** `https://….trycloudflare.com`. Link hiện tại nằm ở `public-link.txt`.
- **Link đổi mỗi khi tắt/bật lại** (Quick Tunnel không cố định). Muốn link cố định cần tên miền trong tài khoản Cloudflare (tunnel có tên).
- Mật khẩu là `STORYPROMPT_ACCESS_PASSWORD` trong `.env` (tự tạo lần đầu, không bao giờ in ra). Đăng nhập xong cookie phiên (HttpOnly, Secure, SameSite=Lax) có hạn 30 ngày; sai 5 lần thì khoá địa chỉ đó 15 phút, sai 20 lần tổng cộng thì khoá chung 15 phút.
- Mọi đường dẫn, kể cả `/api/flow`, đều cần đăng nhập khi đi qua link. Truy cập trực tiếp `http://localhost:47230` trên chính máy này vẫn không cần mật khẩu.
- Cần `cloudflared`: `winget install Cloudflare.cloudflared`.
- Ai có mật khẩu là điều khiển được tài khoản Google Flow của bạn: đừng chia sẻ.
