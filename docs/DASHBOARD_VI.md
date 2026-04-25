# Cua Trading Dashboard Realtime

Bản này có giao diện web realtime cho Polymarket bot, thương hiệu **Cua Trading**.
Bạn có thể **Start / Pause / Resume / Stop** bot ngay trên web, không cần gõ lệnh bot bằng tay.

## 1) Cài package

```powershell
bun install
```

## 2) Chạy dashboard

Mở VS Code terminal, chạy:

```powershell
bun run dashboard
```

Hoặc:

```powershell
bun run cua
```

Sau đó mở trình duyệt:

```text
http://localhost:3000
```

## 3) Start bot trên web

Trên dashboard:

1. Chọn `Strategy`, mặc định `late-entry`
2. Nhập `Rounds`, ví dụ `20`
3. Bấm **START**

Dashboard sẽ tự chạy bot bằng lệnh tương đương:

```powershell
bun run index.ts --strategy late-entry --slot-offset 1 --rounds 20 --always-log
```

## 4) Pause / Resume / Stop

### PAUSE
- Không tạo market mới.
- Lifecycle đang chạy sẽ được yêu cầu dừng an toàn.
- Bot vẫn còn process, có thể Resume.

### RESUME
- Mở lại trạng thái chạy.
- Bot có thể tiếp tục tạo market mới.

### STOP
- Gửi lệnh dừng graceful cho bot.
- Nếu bot do dashboard mở, dashboard cũng gửi SIGTERM sau vài giây nếu process chưa tự thoát.

## 5) Production bị khóa mặc định

Dashboard không cho Start PROD trừ khi bạn tự bật:

```env
DASHBOARD_ALLOW_PROD_START=true
```

Mặc định nên để khóa để tránh bấm nhầm chạy tiền thật.

## 6) Đổi port dashboard

```powershell
$env:DASHBOARD_PORT=3001
bun run dashboard
```

Mở:

```text
http://localhost:3001
```

## 7) Các file quan trọng

```text
dashboard/server.ts          Server dashboard + API Start/Pause/Stop
dashboard/index.html         Giao diện Cua Trading
engine/bot-control.ts        File điều khiển pause/stop
engine/dashboard-state.ts    State realtime cho dashboard
state/dashboard.json         Dữ liệu dashboard realtime
state/bot-control.json       Lệnh điều khiển bot
```

## 8) Cách chạy khuyên dùng

Chỉ cần 1 terminal:

```powershell
bun run dashboard
```

Sau đó mở web và bấm **START**.


## Vì sao Price to beat / Gap hiện `Chưa mở phiên`?

Engine dùng `--slot-offset 1`, nghĩa là nó chuẩn bị market tiếp theo trước khi market mở. Với market 5m:
- Nếu `remainingSecs > 300`, market chưa mở nên chưa có `Price to beat`.
- Khi market mở (`remainingSecs <= 300`), Polymarket mới có `openPrice`, lúc đó dashboard sẽ tự hiện `Price to beat` và `Gap`.
- Nếu market đã mở mà vẫn hiện `Đang lấy...`, hãy đợi vài giây hoặc kiểm tra feed/API.


## Dashboard không khớp market mới nhất?

Nếu bot có nhiều lifecycle cùng lúc, dashboard sẽ ưu tiên hiển thị:
1. Market đã mở (`marketOpen=true`)
2. Market đang `RUNNING`
3. Slug mới nhất

Bản này cũng hiển thị danh sách `Các lifecycle đang theo dõi`, nên bạn sẽ thấy market cũ đang chờ `destroy()` và market mới đang chạy cùng lúc. Đây là bình thường.

## Muốn chạy sát Polymarket hiện tại

Trong dashboard để `Slot offset = 0`, rồi bấm `STOP` và `START` lại.
Nếu trình duyệt vẫn hiện input cũ, bấm `Ctrl + F5` để clear cache.
