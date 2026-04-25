# V4 Smart Hedge + Realtime PNL

Bản này thêm 2 phần quan trọng:

## 1) Smart Hedge bắt đáy/đảo chiều

Sau khi đã có first-leg, bot không còn bắt buộc mua hedge ngay khi vừa đạt `SUM < 1.00`.

Logic mới:

- Nếu hedge price rơi cực sâu `<= SMART_HEDGE_INSTANT_PRICE` thì mua ngay.
- Nếu hedge price đã rơi sâu `<= SMART_HEDGE_ENTRY_MAX_PRICE`, bot ghi nhận đáy.
- Khi giá bắt đầu hồi lên từ đáy ít nhất `SMART_HEDGE_REBOUND_CENTS`, bot mua ngay để tránh bị đảo mất giá đẹp.
- Nếu gần hết giờ hoặc giữ quá lâu, bot vẫn rescue theo `MAX_RESCUE_SUM`.

Ví dụ:

```txt
First-leg SELL = 0.48
Hedge cần mua BUY
BUY rơi xuống 0.06
=> vì <= SMART_HEDGE_INSTANT_PRICE=0.08 nên bot bắn BUY ngay.
```

Ví dụ bắt đảo chiều:

```txt
First-leg SELL = 0.48
BUY rơi 0.24 -> 0.18 -> 0.12
Bot ghi đáy 0.12
BUY hồi lên 0.13
Nếu SMART_HEDGE_REBOUND_CENTS=1
=> bot bắn BUY ngay.
```

## 2) PNL realtime

Bản cũ chỉ cộng PNL sau khi market settle, nên phải chờ 5-6 phút.

Bản V4 hiển thị PNL tạm tính ngay:

- Nếu chỉ có 1 phe: tính theo best bid hiện tại.
- Nếu đã có đủ BUY + SELL cùng shares: tính cặp đó có settle value $1 ngay.
- `PNL realtime = PNL đã settle + PNL tạm tính lệnh đang mở`.

## ENV quan trọng

```env
TRADE_SHARES=1
SMART_HEDGE_ENABLED=true
SMART_HEDGE_ENTRY_MAX_PRICE=0.35
SMART_HEDGE_INSTANT_PRICE=0.08
SMART_HEDGE_REBOUND_CENTS=1
SMART_HEDGE_MAX_WAIT_MS=150000
MAX_RESCUE_SUM=1.02
GAP_HEDGE_ORDER_TYPE=GTC
GAP_HEDGE_FILL_TIMEOUT_MS=2500
```

Muốn trở lại kiểu hedge ngay khi đạt `SUM < 1.00`:

```env
SMART_HEDGE_ENABLED=false
```
