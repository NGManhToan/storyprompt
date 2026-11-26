# QA test report

Không có ECC agents/skills trong môi trường này. Kiểm thử trình duyệt dùng Chrome headless (puppeteer-core), không phải bộ Playwright đã cài trong repo. `reference.png` không có trong file gửi; ảnh mẫu là bản render `design-reference/index.html`.

| Test ID | Module | Scenario | Preconditions | Steps | Expected | Actual | Status | Severity | Screenshot | Root cause | Resolution |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| UI-001 | Empty | Chưa có file | App mới | Mở `/` | Onboarding đủ logo, tiêu đề, drop, hai nút, hướng dẫn | Card “Mở kịch bản” có đủ các phần đó | PASS | P1 | empty-1024.png | Workspace trống vì không tách empty state | Màn riêng khi `scenes.length === 0` |
| UI-002 | Empty | Drag and drop | App mới | Nhìn vùng thả | Có vùng drop | Có label.drop và onDrop; chưa thả file thật trong phiên này | PARTIAL | P1 | empty-1024.png | Trước đó không có vùng drop | Đã gắn handler; drop thật chưa chạy |
| UI-003 | Empty | Gom nút | App mới | Nhìn card | Chọn file và Mở file mẫu nằm trong card | Cả hai nằm trong `.empty-card` | PASS | P1 | empty-1024.png | Hai nút nằm ở scene-head | Đưa vào card |
| UI-004 | Empty | Ẩn thống kê 0 | App mới | Đếm `.overview` | Không hiện | `overview: false` | PASS | P2 | empty-1024.png | Overview luôn render | Ẩn khi chưa có cảnh |
| UI-005 | Empty | Ẩn bộ lọc | App mới | Đếm `.tabs` | Không hiện | `filters: false` | PASS | P1 | empty-1024.png | List luôn render | Ẩn cùng empty state |
| UI-006 | Empty | Disable nút | App mới | Đọc thuộc tính disabled | Mô phỏng, Chạy, Xuất disabled | Cả ba `disabled === true` | PASS | P1 | empty-1024.png | CSS không làm nút disabled khác nút thường; Xuất không disabled | Thêm opacity và disabled |
| UI-007 | Save | Nhãn lưu | Fixture 176 cảnh | Đọc `.saved` | Không vừa “Đã lưu tự động” vừa “Chưa có bản lưu” | Text là “Chưa lưu” | PASS | P1 | app-1024x576.png | Nhãn cứng | Bốn trạng thái Saving/Saved/Unsaved/Failed |
| UI-008 | Header | 0% không có đoạn xanh | Fixture, 0 cảnh xong | Đọc width của `.track i` | 0 | `width: 0%` | PASS | P2 | app-1024x576.png | CSS gốc đặt dấu 9px | Width theo phần trăm |
| UI-009 | List | Sidebar ~25% | 1024 và 1920 | Đo `.scenes` | Khoảng 25% | 251/1024 = 24.5%; 473/1920 = 24.6% | PASS | P1 | app-1024x576.png | `--u` kẹp 1.4px nên cột 252u chỉ còn ~19% trên màn rộng | `minmax(240px, 25%)` |
| UI-010 | List | Bộ lọc không tràn | 1024 | `scrollWidth` nút lọc | Không tràn | `overflow: false` trên nút “Đang chờ”; bộ lọc xuống hai hàng | PASS | P1 | app-1024x576.png | 4 nhãn 8px không vừa cột hẹp | Wrap + cỡ chữ 12px |
| UI-011 | List | List cao, scroll riêng | 1024 | CSS `#list` flex 1 | Hết chiều cao cột, scroll riêng | CSS đã đổi; chưa đo dòng cuối có bị cắt pixel | PARTIAL | P1 | app-1024x576.png | `max-height: 270u` | Bỏ max-height, flex 1 |
| UI-012 | Editor | Độ rộng đọc | Không ảnh | Class solo | Tối đa 68ch | Khi có ảnh thì hai cột; solo chỉ khi không ảnh. Fixture có ảnh nên không đo 68ch | PARTIAL | P1 | app-1024x576.png | `grid-template-columns: 1fr` khi ẩn gallery | Class `.solo` |
| UI-013 | Editor | Tỷ lệ card | Có ảnh | Nhìn hai card | Prompt cao hơn lời thoại theo mẫu | Vẫn dùng `.78fr 1fr` của style.css; chưa đo pixel so với mẫu | PARTIAL | P1 | app-1024x576.png | Card giãn full khi không ảnh | Giữ tỷ lệ mẫu khi có ảnh |
| UI-014 | Ảnh | Thêm ảnh | Fixture | Tìm nút | Có nút Thêm ảnh | `add: true` | PASS | P1 | app-1024x576.png | Chỉ nhận drop, không có nút | Nút trên action bar |
| UI-015 | Layout | Khoảng trống dưới | 1024×576 | `getBoundingClientRect` của #save | Action bar trong khung nhìn | bottom 571 / cao 576, sát mép | PARTIAL | P2 | app-1024x576.png | Cột list ngắn để đáy viewport trống; nay list kéo cao nên action sát đáy | Chưa nới thêm |
| UI-016 | Restore | Contrast Tiếp tục/Bỏ | Có checkpoint | Mở banner | Chữ đọc được | Banner dùng `--ink` trên `--card`; phiên này không tạo được checkpoint để bấm | NOT TESTED | P1 |  | Toast xanh đè chữ nút | Đổi sang banner; chưa bấm thật |
| UI-017 | Restore | Vị trí banner | Có checkpoint | Nhìn vị trí | Giữa, trên | CSS `.restore` top giữa; chưa hiện trong phiên | NOT TESTED | P1 |  | `#toast` góc dưới | Component mới, chưa kích hoạt |
| UI-018 | Header | Progress không nuốt header | 1024 | `scrollWidth` | Không tràn ngang | overflow 0; track tối đa 110px | PASS | P2 | app-1024x576.png | `.progress { flex:1 }` | Track cố định |
| UI-019 | Header | Logo | 1024 | Nhìn logo | Tam giác đặc, không nét outline | Ô xanh có Play tô đặc. Khác glyph trần trong index.html | PARTIAL | P2 | app-1024x576.png | Lucide Play là stroke | Fill + nền xanh |
| UI-020 | Type | Cỡ chữ nút | 1024 | CSS | Đọc được | Tối thiểu 12px cho tab, pill, action | PARTIAL | P2 | app-1024x576.png | Token 8u–10u | `max(12px, …)` |
| UI-021 | A11y | Tooltip icon | 1024 | `title` trên rail | Có tooltip | Có `title` trên rail, Chuông, nền, Thêm ảnh | PASS | P2 |  | Nút chỉ có glyph | Đã thêm title |
| UI-022 | Tokens | Màu và shadow | 1024 | So với style.css | Cùng token | Nền, nút, thẻ vẫn dùng biến của style.css; empty state và banner là lớp thêm | PARTIAL | P2 | app-1024x576.png | Lớp CSS cũ chồng | Giữ token, thêm lớp có chủ đích |
