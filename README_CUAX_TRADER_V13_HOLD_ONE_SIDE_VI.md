# CuaX Trader V13 — HOLD 1 SIDE khi SUM > 1.03

Bản này được sửa từ V12 theo yêu cầu: **khi tổng giá first-leg + hedgeAsk vượt 1.03 thì bot không vào hedge nữa, giữ 1 bên**.

## Logic mới

- Bot vẫn vào first-leg theo tín hiệu GAP.
- Nếu hedge đối diện rẻ và tổng BUY+SELL <= `PROFIT_MAX_SUM`, bot khóa hedge để lấy edge.
- Nếu tổng first-leg + hedgeAsk > `ONE_SIDE_HOLD_ABOVE_SUM` mặc định **1.03**, bot bật chế độ **HOLD_ONE_SIDE**.
- Khi đã bật HOLD_ONE_SIDE, bot **không LOCK hedge, không RESCUE hedge, không SELL thoát first-leg chỉ vì gần hết giờ**.
- Dashboard sẽ hiện mode `HOLD_ONE_SIDE` và lý do: `SUM > 1.03`.

## ENV nên dùng trên Railway

```env
GAP_INVERT_SIGNAL=false
FIRST_LEG_MAX_PRICE=0.85
PROFIT_MAX_SUM=0.97
TAKE_PROFIT_MAX_SUM=0.97
MIN_LOCK_EDGE_CENTS=3
ARB_MAX_ENTRY_SUM=0.97
ARB_MIN_EDGE_CENTS=3
MAX_RESCUE_SUM=1.03

ONE_SIDE_HOLD_ENABLED=true
ONE_SIDE_HOLD_ABOVE_SUM=1.03
ONE_SIDE_HOLD_PERMANENT=true
```

## Ghi chú rủi ro

HOLD 1 SIDE có thể tăng lợi nhuận khi phe đang giữ đi đúng hướng, nhưng rủi ro lớn hơn arbitrage vì nếu phe đó thua settlement thì mất vốn first-leg. Nên chạy SIM hoặc số share nhỏ trước khi tăng size.
