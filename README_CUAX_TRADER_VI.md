# CuaX Trader - Hybrid GAP + 6-Layer Arb

Bản này là giao diện mới cho Railway:

- Đổi tên dashboard thành **CuaX Trader**.
- Full tiếng Việt.
- Giao diện cyber/pro chuyên nghiệp hơn.
- Có animation radar scan, hiệu ứng loading pipeline, popup từng quy trình.
- Giữ logic V5 Fast Smart Hedge.
- Giảm lag dashboard bằng cách giới hạn feed/log, refresh 1.5s, chỉ render lại khi dữ liệu đổi.

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

## Deploy Railway

Railway dùng sẵn:

```txt
Dockerfile
railway.json
bun run start
/health
```

Không cần set `DASHBOARD_PORT`, Railway tự cấp `PORT`.

## ENV test an toàn

```env
DASHBOARD_DEFAULT_STRATEGY=gap-six-layer-arb
FORCE_PROD=false
DASHBOARD_ALLOW_PROD_START=false
ALLOW_GAP_SIX_LAYER_ARB_PROD=false
TRADE_SHARES=1
SMART_HEDGE_ENABLED=true
SMART_HEDGE_INSTANT_PRICE=0.12
SMART_HEDGE_TAKE_EDGE_CENTS=8
SMART_HEDGE_DECISION_MS=8000
GAP_HEDGE_ORDER_TYPE=GTC
MAX_RESCUE_SUM=1.02
```

## Lưu ý

Bản này mặc định là SIM. Muốn chạy PROD phải tự bật khóa trong ENV và tự chịu rủi ro.
