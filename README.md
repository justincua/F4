# Cua / PolyClaw Style 6-Layer Arbitrage Engine

Bản này đã được update theo concept trong video: dashboard realtime dark/cyber + pipeline 6 lớp cho Polymarket binary markets.

## Logic chính

Với thị trường binary YES/NO, một bên thắng redeem `$1.00`. Khi orderbook bị lệch:

```txt
YES ask + NO ask < 1.00
```

Engine sẽ mua cả 2 bên cùng số shares. Ví dụ:

```txt
YES = 0.54
NO  = 0.43
SUM = 0.97
EDGE = 0.03 = 3 cents/share
```

Nếu cả 2 bên đều fill đủ, payout cuối cùng gần như cố định theo số shares. Nhưng vẫn có rủi ro khi chỉ fill một bên, thiếu thanh khoản, phí, trượt giá, hoặc market có dispute.

## 6-Layer Pipeline

```txt
01 Scan      quét YES/NO orderbook
02 Detect    phát hiện YES + NO dưới ngưỡng
03 Validate  kiểm tra edge, depth, thời gian còn lại
04 Size      tính shares có thể vào
05 Fill      gửi BUY YES + BUY NO
06 Hedge     nếu fill lệch thì rescue bên thiếu hoặc bán thoát bên đã fill
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

## Biến ENV quan trọng

```env
DASHBOARD_DEFAULT_STRATEGY=gap-six-layer-arb
TRADE_SHARES=10
ARB_MIN_EDGE_CENTS=1
ARB_MAX_ENTRY_SUM=0.99
ARB_MAX_RESCUE_SUM=1.01
ARB_SCAN_MS=120
ARB_FILL_TIMEOUT_MS=1800
ARB_MAX_ARBS_PER_MARKET=1
ARB_ORDER_TYPE=FOK
```

## Railway

Project đã có `Dockerfile` + `railway.json`. Deploy lên Railway bằng GitHub như bản cũ.

Mặc định:

```env
AUTO_START_BOT=true
DASHBOARD_ALLOW_PROD_START=false
ALLOW_SIX_LAYER_ARB_PROD=false
```

Nghĩa là chạy SIM an toàn. Muốn chạy PROD phải tự set key và tự mở khóa production.

## Cảnh báo

Dashboard và strategy này là khung kỹ thuật để test/simulation. Không có đảm bảo lợi nhuận. Đừng bật production nếu chưa backtest/paper trade đủ lâu và hiểu rõ rủi ro fill lệch, fee, slippage, thanh khoản, API latency và settlement dispute.
