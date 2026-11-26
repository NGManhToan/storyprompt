# Kế hoạch refactor UI

Giữ nguyên pipeline, validator, provider và export. Chỉ đổi lớp giao diện.

1. Đặt lời thoại và prompt trong một cột. Ảnh chỉ xuất hiện bên cạnh cột đó khi cảnh có ảnh người dùng gắn, tỷ lệ 16:9, `object-fit: contain`. Không còn ảnh phố mẫu cho mọi cảnh.
2. Màn chưa có file là một thẻ upload giữa trang: tiêu đề ngắn, vùng kéo thả nét đứt, nút mở file mẫu.
3. Header 64px, tiến độ ngắn ở giữa, nút có icon Lucide.
4. Rail icon 68px, tooltip, nút thu danh sách. Cột cảnh 280–320px, mỗi dòng 42px, cuộn riêng.
5. Chỉ số trải trên chiều ngang, vòng tiến độ, trạng thái lưu kèm icon cloud.
6. Token màu và font Inter theo design system. Trạng thái: chờ xám, xong xanh, cần kiểm tra vàng.
7. Nút: Lưu là primary, Viết lại và Sao chép là secondary, Xóa là ghost.
