# CuaX Trader V7 UI Fix

Bản này sửa lỗi giao diện bị chồng chéo ở màn hình thấp / webview Railway:

- Bỏ khóa `body overflow:hidden`, cho phép trang cuộn tự nhiên.
- Giảm chiều cao radar, pipeline, card giá, chart và log để vừa màn hình hơn.
- Thêm breakpoint cho màn hình desktop thấp dưới 820px.
- Pipeline tự đổi 3 cột khi chiều ngang hẹp, tránh đè lên block phía dưới.
- Các ô chữ dài tự wrap, không tràn layout.
- Giữ nguyên logic V5 Fast Smart Hedge và giao diện CuaX Trader.

Deploy Railway vẫn dùng `bun run start`.
