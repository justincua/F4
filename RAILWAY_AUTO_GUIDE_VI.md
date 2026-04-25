# CUA TRADING / POLY BOT PRO — Railway Auto Deploy

Bản này đã được chỉnh để chạy trên Railway dạng **dashboard + bot auto-start**.

## 1) Các file đã thêm/sửa

- `Dockerfile` — build bằng Bun trên Railway.
- `railway.json` — healthcheck `/health`, start command `bun run start`.
- `package.json` — thêm script `start`.
- `dashboard/server.ts` — đọc `PORT` của Railway, bind `0.0.0.0`, có `/health`, auto-start bot.
- `engine/strategy/late-entry.ts` — `TRADE_SHARES` đọc từ ENV, không còn hard-code 6 shares.
- `.env.sample` — mẫu biến môi trường Railway.

## 2) Env nên set trên Railway

Dán các biến này trong Railway → Service → Variables:

```env
TICKER=coinbase
MARKET_ASSET=btc
MARKET_WINDOW=5m
WALLET_BALANCE=50
MAX_SESSION_LOSS=3

TRADE_SHARES=10

DASHBOARD_DEFAULT_STRATEGY=late-entry
DASHBOARD_DEFAULT_ROUNDS=unlimited
DASHBOARD_DEFAULT_SLOT_OFFSET=0
DASHBOARD_KEEP_HISTORY=true

AUTO_START_BOT=true
AUTO_RESTART_BOT=true
AUTO_RESTART_MAX=3
BOT_RESTART_DELAY_MS=5000

# Mặc định an toàn, chưa chạy tiền thật:
FORCE_PROD=false
DASHBOARD_ALLOW_PROD_START=false
```

Không cần set `PORT`; Railway tự cấp.

## 3) Cách deploy nhanh

1. Giải nén source này.
2. Push toàn bộ folder lên GitHub.
3. Railway → New Project → Deploy from GitHub Repo.
4. Chọn repo.
5. Vào Variables, dán env ở trên.
6. Deploy lại.
7. Mở public URL của Railway.

Khi deploy xong, dashboard tự mở, bot tự chạy nếu `AUTO_START_BOT=true`.

## 4) Set 10 shares

Bản này dùng:

```env
TRADE_SHARES=10
```

Log lúc vào lệnh sẽ hiện `shares=10` ở dashboard controller message. Lưu ý: lệnh thực tế có thể fill ít hơn nếu orderbook thiếu thanh khoản hoặc có fee/partial fill.

## 5) Chạy liên tục hay giới hạn vòng

Chạy liên tục:

```env
DASHBOARD_DEFAULT_ROUNDS=unlimited
```

Chỉ chạy 20 phiên rồi dừng:

```env
DASHBOARD_DEFAULT_ROUNDS=20
```

## 6) Production

Bản này mặc định khóa Production để tránh bấm nhầm chạy tiền thật.

Muốn mở Production cần tự set thêm:

```env
DASHBOARD_ALLOW_PROD_START=true
FORCE_PROD=true
PROD=true
ALLOW_LATE_ENTRY_PROD=true
PRIVATE_KEY=...
POLY_FUNDER_ADDRESS=...
BUILDER_KEY=...
BUILDER_SECRET=...
BUILDER_PASSPHRASE=...
```

Nếu không set `ALLOW_LATE_ENTRY_PROD=true`, strategy `late-entry` sẽ tự chặn Production và thoát để tránh chạy nhầm tiền thật.

Vẫn nên test SIM trước. Không có chiến lược nào đảm bảo thắng; chạy tiền thật có thể mất vốn.

## Fix Healthcheck Railway

Bản v2 này bind server bằng `BIND_HOST=0.0.0.0`, không đọc biến `HOSTNAME`, vì Docker/Railway tự tạo `HOSTNAME` là container id. Nếu app bind nhầm vào `HOSTNAME`, Railway có thể build xong nhưng healthcheck `/health` không gọi được.

Không tự set `PORT`; Railway sẽ tự cấp `PORT`.
