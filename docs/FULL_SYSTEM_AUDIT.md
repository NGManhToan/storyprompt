# Full system audit

Không có ECC trong repo hay skill máy. Dùng Chrome headless thay Playwright.

`reference.png` không được gửi. Ảnh chuẩn là render của `design-reference/index.html` + `style.css` + `app.js`.

## Nguyên nhân gốc đã xác nhận

- Cột cảnh 19% trên màn rộng vì `--u` bị kẹp ở 1.4px trong khi cột workspace là `1fr`.
- Danh sách chỉ cao `270u` nên không dùng hết chiều cao và cắt dòng.
- Khi không có ảnh, editor đặt `grid-template-columns: 1fr` nên chữ chạy hết bề ngang.
- Empty state không tồn tại: overview, bộ lọc và nút vẫn render với số 0.
- Nút disabled không có style nên trông bấm được. Xuất không bị disable.
- “Đã lưu tự động” là chữ cứng, đi kèm “Chưa có bản lưu”.
- Thanh tiến độ có một vạch xanh 9px kể cả khi 0%, và `flex: 1` làm track rất dài.
- Ảnh theo cảnh chỉ nằm trong React state dạng object URL nên mất khi tải lại.
- Viết lại prompt xóa `prompt` trong `prior` trước khi API trả về, nên lỗi mạng để lại prompt rỗng.
- Bản lưu hiện bằng `#toast` nền xanh, nút kế thừa màu khó đọc và nằm góc dưới.

## Cấu trúc

Presentation nằm trong `src/ui/App.tsx` và `src/styles.css`. State và API nằm trong `useStudio.ts`, checkpoint IndexedDB trong `storage.ts`. Pipeline không bị đổi thuật toán prompt.

Checkpoint git trước đợt này: `checkpoint-before-audit-fix`.
