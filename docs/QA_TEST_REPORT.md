# QA test report

Kiểm trên trình duyệt desktop của môi trường dev và `npm test` (34 test lõi, pass). Chưa chạy Playwright trên đủ 6 viewport.

| Mã | Kết quả | Ghi chú |
| --- | --- | --- |
| UI-01 | Pass | Lời thoại nằm trên prompt. Không có ảnh thì cột nội dung full ngang. |
| UI-02 | Pass | Chỉ số trải trên hàng thống kê. |
| UI-03 | Pass | Lucide, cỡ khoảng 18px. |
| UI-04 | Blocked | Khung 16:9 chỉ hiện sau khi gắn ảnh cho một cảnh. Chưa chụp ca có ảnh. |
| UI-05 | Pass | “Đang chờ” xám. Xanh và vàng có token, chưa có cảnh ở hai trạng thái đó trên màn hình mẫu. |
| UI-06 | Pass | Màn “Mở kịch bản”, vùng nét đứt, nút file mẫu. |
| UI-07 | Pass | Nền kem, nút `#456B50`. |
| UI-08 | Blocked | Mới xem một cửa sổ desktop. |
| UI-09 | Pass | Đổi nền được. Ô lời thoại từng trắng trên chữ sáng ở dark mode, đã đổi sang token. |
| FN-01 | Blocked | Chưa thả file người dùng trong phiên này. File mẫu mở được. |
| FN-02 | Pass | Unit test cắt cảnh. Mẫu heading vẫn theo tiêu đề cảnh. |
| FN-03 | Pass | Tìm “bếp” còn 4 cảnh, xóa lọc thì đủ 20. |
| FN-04 | Pass | Cảnh sau đổi 1/20 thành 2/20 và đổi lời thoại. |
| FN-05 | Blocked | Banner khôi phục hiện và bấm Bỏ được. Chưa bấm Tiếp tục trong phiên này. |
| FN-06 | Blocked | Chưa chạy API thật. |
| FN-07 | Blocked | Nút Sao chép có phản hồi “Đã chép”, chưa đọc clipboard. |
| FN-08 | Blocked | Ảnh theo cảnh chỉ có sau “Thêm ảnh”. |
| FN-09 | Pass | Cảnh không ảnh thì nội dung mở full ngang. |
| FN-10 | Blocked | Nút Xuất tắt khi chưa có prompt dùng được. |
| UX-01 | Blocked | Ctrl+S vẫn gắn trong code, chưa bấm trong trình duyệt. |
| UX-02 | Pass | Empty state. Chưa chủ động gây lỗi API. |
| UX-03 | Pass | Đổi cảnh và thu sidebar không xóa prompt trên màn hình. |
| UX-04 | Blocked | Nút có `aria-label` và `title`. Chưa duyệt bàn phím hết luồng. |

Unit test nghiệp vụ: 34/34 pass. Không thấy toast lỗi trên các thao tác đã bấm.
