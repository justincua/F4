# CuaX Trader V10 Pixel Pro

Bản này nâng cấp từ V9 Deploy Safe:

- Giao diện pixel gọn hơn, nhẹ hơn, responsive cho mobile.
- Bỏ tải font Google để Railway/mobile mở nhanh hơn.
- Feed/log/chart được giới hạn lại để giảm lag khi chạy lâu.
- Thêm khu vực Profit Lock: hiển thị SUM limit, lợi nhuận dự kiến, trạng thái có lời.
- Engine thêm `PROFIT_LOCK_ENABLED` và `PROFIT_MAX_SUM`.
- Logic chốt: nếu BUY + SELL <= `PROFIT_MAX_SUM` thì bắn lock/hedge ngay, không chờ sâu.

ENV khuyên dùng:

```env
PROFIT_LOCK_ENABLED=true
PROFIT_MAX_SUM=0.999
MIN_LOCK_EDGE_CENTS=0
ARB_MAX_ENTRY_SUM=0.999
SMART_HEDGE_ENABLED=false
GAP_ORDER_TYPE=GTC
GAP_FIRST_ORDER_TYPE=GTC
GAP_HEDGE_ORDER_TYPE=GTC
```

Giữ an toàn deploy:

```env
START_ONLY_NEW_SLOT=true
ENTRY_MAX_OPENED_SECS=45
ENTRY_MIN_REMAINING_SECS=240
```
