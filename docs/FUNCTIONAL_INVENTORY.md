# Functional inventory

## Trước rebuild giao diện (commit de698a3 và sớm hơn)

Mở file, file mẫu, mô phỏng, chạy, dừng, xuất TXT/JSON/CSV/Flow, sửa và lưu prompt, Ctrl+S, story settings, theme, checkpoint IndexedDB, báo cáo lượt chạy, validator.

## Sau rebuild 1430f4b

Giữ các chức năng trên. Thêm gallery chỉ khi cảnh có ảnh. Mất nút thêm ảnh rõ ràng và empty state. Ảnh không được ghi checkpoint.

## Sau đợt audit này

Giữ pipeline. Thêm: empty state, drag vùng thả, disable nút khi chưa đủ dữ liệu, nhãn lưu theo trạng thái, Thêm ảnh / xóa ảnh, ảnh ghi IndexedDB store `stills`, draft prompt giữ khi đổi cảnh, viết lại không xóa prompt cũ trong prior, hộp xác nhận trước khi xóa, banner khôi phục.
