# UI audit

Đối chiếu giao diện trước lần refactor này với bản review ECC và ảnh mẫu.

## Nguyên nhân layout sai

Khung cảnh đang là lưới hai cột ở hàng trên (lời thoại | ảnh) và prompt trải hết hàng dưới. Ảnh là một file mẫu cố định, `object-fit: cover` trong khung thấp, nên bị cắt và thumbnail lặp cùng một ảnh cho mọi cảnh.

## Lỗi đã ghi nhận

| Mã | Vấn đề | Nguyên nhân |
| --- | --- | --- |
| P0 | Prompt không nằm dưới lời thoại | `editor-grid` đặt prompt `grid-column: 1 / -1` |
| P0 | Ảnh mẫu cho mọi cảnh, bị cắt | `public/preview.jpg` luôn gắn, không có ảnh theo cảnh |
| P1 | Header dồn hai đầu, thanh tiến độ kéo dài | `.top-progress` dùng `flex: 1` trên track |
| P1 | Chỉ số dồn trái | Hàng thống kê không chia đều |
| P1 | Cột cảnh rộng theo phần trăm | `minmax(250px, 27%)` |
| P1 | Icon lẫn Unicode và SVG tự vẽ, kích thước lệch | Không dùng một bộ icon |
| P1 | Chữ serif rất lớn ở màn trống | `.empty h1` dùng Newsreader, cỡ 40–64px |
| P1 | “Đang chờ” tô xanh | Pill dùng màu accent cho mọi trạng thái |
| P1 | Nút thiếu icon và thứ bậc | Cùng một style viền |
| P2 | “Đã lưu” là chữ nhỏ tách khỏi icon | Không có icon cloud |
