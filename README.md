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

## Cách dùng

1. Thả file `.srt`. Nếu file có dòng `CẢNH n` / `SCENE n` / `INT.` / `EXT.`, các cue được gom thành cảnh. Không có tiêu đề thì mỗi cue là một cảnh.
2. Kiểm tra tên nhân vật. Tên lấy từ người nói và các cách gọi như “ông Hải”, không hard-code.
3. **Chạy mô phỏng** để xem pipeline (validator, viết lại, báo cáo) mà không tốn quota.
4. **Chạy thật** khi đã có khóa. Lô 4–8 cảnh. Cảnh trước và sau đi kèm, đánh dấu chỉ đọc.
5. Sửa từng hàng hoặc bấm **Viết lại**. Bản lưu nằm trong IndexedDB, mở lại file là có thể tiếp tục.
6. **Sao chép**, **TXT**, **JSON**, hoặc **Gói Flow** (`storyprompt-flow-v1`: mỗi cảnh một `id` + `prompt`).

Story bible (địa điểm và ánh sáng ổn định) nằm sau công tắc. Tắt mặc định vì nó đổi cấu trúc prompt.

Ngoại hình không được mô tả trong prompt. Ảnh tham chiếu của Flow giữ mặt và trang phục. Tiền tố / hậu tố do code gắn thêm, không phải model.

## Hạn mức

Mặc định thận trọng, sửa trong Cài đặt cho đúng hạn mức khóa của bạn:

| | Mặc định |
| --- | --- |
| RPM | 15 |
| TPM | 250.000 |
| RPD | 500 |
| Lô | 6 |
| Luồng | 4 |
| Viết lại | 3 lần, từng cảnh một |
| maxOutputTokens | 8192 |

429 được chờ theo `retry-after`, rồi mới tăng dần. Bộ đếm request trong ngày nằm trên trình duyệt.

Với 211 cảnh, lô 6 là khoảng 36 request cho lượt đầu, cộng thêm các cảnh bị loại. Ở 15 RPM, sàn thời gian khoảng vài phút, chưa tính độ trễ và lần viết lại. Ứng dụng không hứa một con số. Báo cáo sau mỗi lượt ghi thời gian tường, token, tỉ lệ đạt và lý do loại.

Model Gemini mặc định: `gemini-3.1-flash-lite`, rồi `gemini-3.8-flash`, rồi `gemini-flash-latest` nếu model trước trả 404. Nếu AI Studio đổi tên, dán đúng id vào ô model.

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
NODE_ENV=production npm start
```

Cloud Run:

```bash
gcloud run deploy storyprompt-web --source . --region asia-southeast1 --allow-unauthenticated --set-env-vars GEMINI_API_KEY=YOUR_KEY
```

Server đọc `PORT`. Khóa trong header của request chỉ dùng cho request đó, không ghi log, không ghi đĩa.

### Google AI Studio

App là Vite + React và `server.ts` (Node, `@google/genai` trên server, REST dự phòng). Chạy bằng `npm run dev` hoặc `npm start`. AI Studio inject `GEMINI_API_KEY`; health check sẽ báo Gemini sẵn và giao diện gọi `/api/generate` từng lô.

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
