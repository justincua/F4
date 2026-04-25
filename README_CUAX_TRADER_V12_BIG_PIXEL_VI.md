# CuaX Trader V12 Big Pixel UI

Bản này sửa giao diện pixel bị quá nhỏ:

- Chữ lớn hơn, đọc rõ trên desktop và mobile.
- Layout tự ẩn cột phải khi màn hình không đủ rộng.
- Mobile dùng tab INFO / TRADE / LOG.
- Giữ radar scan, pipeline, feed realtime nhưng giảm lag.
- Giữ engine V11: PROD ready, deploy safe, profit lock 0.90.

ENV khuyên dùng cho lợi nhuận rõ:

```env
PROFIT_LOCK_ENABLED=true
PROFIT_MAX_SUM=0.90
TAKE_PROFIT_MAX_SUM=0.90
ARB_MAX_ENTRY_SUM=0.90
ARB_MIN_EDGE_CENTS=10
MIN_LOCK_EDGE_CENTS=10
```

Nếu muốn dễ vào hơn nhưng lời thấp hơn, dùng `0.95` và edge `5`.
