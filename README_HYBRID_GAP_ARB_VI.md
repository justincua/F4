# Cua Hybrid Gap + 6-Layer Arb Engine

Bản này là bản theo đúng ý tưởng mới:

```txt
GAP SIDE = SELL  => mua BUY trước nếu BUY rẻ, ví dụ BUY = 0.46
Sau đó đợi SELL <= 1.00 - BUY - MIN_LOCK_EDGE
Ví dụ MIN_LOCK_EDGE=1 cent => SELL <= 0.53
Khi BUY + SELL < 1.00 và cùng shares => khóa lời lý thuyết.
```

## Strategy mặc định

```env
DASHBOARD_DEFAULT_STRATEGY=gap-six-layer-arb
```

## 6 lớp xử lý

```txt
01 Quét          = lấy orderbook BUY/SELL + gap side
02 Bắt tín hiệu  = pure arb hoặc GAP SIDE
03 Lọc điều kiện = first-leg phải rẻ, liquidity đủ
04 Tính shares   = lấy size theo TRADE_SHARES và depth
05 Vào lệnh      = mua first-leg hoặc mua 2 phe pure arb
06 Khóa/Hedge    = mua phe đối diện để tổng < 1.00 hoặc rescue
```

## Cấu hình quan trọng

```env
TRADE_SHARES=10
FIRST_LEG_MAX_PRICE=0.49
MIN_LOCK_EDGE_CENTS=1
GAP_FIRST_ENTRY_WINDOW_SECS=300
MAX_HOLD_FIRST_LEG_MS=240000
RESCUE_BEFORE_CLOSE_SECS=18
PURE_ARB_ENABLED=true
GAP_SIGNAL_ENABLED=true
```

## Ví dụ

```txt
Market mới mở báo GAP SIDE = SELL
Bot mua BUY first-leg @ 0.46
Target hedge SELL = 1.00 - 0.46 - 0.01 = 0.53
Nếu SELL ask <= 0.53 => bot mua SELL cùng số shares
SUM = 0.99 => khóa edge 1 cent/share
```

## Chạy local

```bash
cp .env.sample .env
bun install
bun run start
```

Mở:

```txt
http://localhost:3000
```

## Railway

Bản này vẫn giữ Dockerfile + railway.json. Railway chạy:

```bash
bun run start
```

Mặc định là SIM. Muốn PROD phải tự bật đầy đủ:

```env
DASHBOARD_ALLOW_PROD_START=true
FORCE_PROD=true
ALLOW_GAP_SIX_LAYER_ARB_PROD=true
```

Không bật PROD nếu chưa test kỹ, vì lúc chỉ có first-leg thì vẫn đang giữ 1 phe, chưa phải arbitrage.


## V3 Fast Hedge

Bản V3 sửa lỗi: nếu đã có first-leg, ví dụ SELL @ 0.49, khi BUY ask rơi về 0.24 thì bot đặt hedge BUY ngay. Hedge không còn bị chặn bởi depth snapshot; lệnh GTC ngắn sẽ đặt tại giá target/giá đang thấy để bắt cú rơi nhanh.

ENV test khuyên dùng:

```env
TRADE_SHARES=1
GAP_MIN_DEPTH_SHARES=1
GAP_MIN_HEDGE_SHARES=1
GAP_HEDGE_ORDER_TYPE=GTC
GAP_HEDGE_FILL_TIMEOUT_MS=2500
MIN_LOCK_EDGE_CENTS=1
MAX_RESCUE_SUM=1.02
```
