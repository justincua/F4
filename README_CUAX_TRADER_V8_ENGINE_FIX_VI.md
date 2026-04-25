# CuaX Trader V8 Engine Fix

Bản V8 sửa phần engine, không chỉ sửa giao diện.

## Điểm đã sửa

- Thêm `GAP_INVERT_SIGNAL`:
  - `false`: GAP BUY => mua BUY, GAP SELL => mua SELL.
  - `true`: GAP BUY => mua SELL, GAP SELL => mua BUY.
- Mặc định dùng `GTC` để test 1 share dễ khớp hơn, không bị FOK kill liên tục.
- Nếu dùng GTC, bot không chặn lệnh chỉ vì depth snapshot mỏng.
- Dashboard hiện rõ **Lý do chưa vào lệnh**.
- Dashboard hiển thị **Vốn realtime = initial balance + PNL live** thay vì chỉ cash balance.
- Pure arb và GAP entry đều hiển thị điều kiện chờ: pure sum cao, edge thấp, GAP bị tắt, hết cửa sổ entry, v.v.

## ENV khuyên dùng để test

```env
TICKER=coinbase
MARKET_ASSET=btc
MARKET_WINDOW=5m
WALLET_BALANCE=50
MAX_SESSION_LOSS=3
FORCE_PROD=false

DASHBOARD_DEFAULT_STRATEGY=gap-six-layer-arb
TRADE_SHARES=1

GAP_SIGNAL_ENABLED=true
PURE_ARB_ENABLED=true
GAP_INVERT_SIGNAL=false
GAP_IGNORE_DEPTH_FOR_GTC=true
FIRST_LEG_MAX_PRICE=0.99
MIN_LOCK_EDGE_CENTS=1
ARB_MAX_ENTRY_SUM=0.99
GAP_FIRST_ENTRY_WINDOW_SECS=300
GAP_MIN_REMAINING_SECS=18
GAP_SCAN_MS=100
GAP_FIRST_FILL_TIMEOUT_MS=1500
GAP_HEDGE_FILL_TIMEOUT_MS=2500
MAX_HOLD_FIRST_LEG_MS=240000
RESCUE_BEFORE_CLOSE_SECS=18
MAX_RESCUE_SUM=1.02
GAP_COOLDOWN_MS=1000
GAP_MAX_CYCLES_PER_MARKET=1
GAP_MIN_DEPTH_SHARES=1
GAP_MIN_HEDGE_SHARES=1
GAP_MIN_ABS_PRICE=0
GAP_ORDER_TYPE=GTC
GAP_FIRST_ORDER_TYPE=GTC
GAP_HEDGE_ORDER_TYPE=GTC
GAP_HEDGE_SLIPPAGE_CENTS=1
ALLOW_PARTIAL_HEDGE=true

SMART_HEDGE_ENABLED=false
REALTIME_PNL_ENABLED=true

DASHBOARD_DEFAULT_ROUNDS=unlimited
DASHBOARD_DEFAULT_SLOT_OFFSET=0
DASHBOARD_KEEP_HISTORY=true
DASHBOARD_ALLOW_PROD_START=false
AUTO_START_BOT=true
AUTO_RESTART_BOT=true
AUTO_RESTART_MAX=3
BOT_RESTART_DELAY_MS=5000
ALLOW_GAP_SIX_LAYER_ARB_PROD=false
ALLOW_SIX_LAYER_ARB_PROD=false
```

## Muốn quay lại kiểu BUY ra SELL

Chỉ đổi:

```env
GAP_INVERT_SIGNAL=true
```

## Muốn chỉ chơi pure arb, không dùng GAP

```env
GAP_SIGNAL_ENABLED=false
PURE_ARB_ENABLED=true
```
