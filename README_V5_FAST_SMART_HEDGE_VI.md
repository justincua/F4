# V5 Fast Smart Hedge - Tiếng Việt

Bản này sửa lỗi V4: bot có thể đợi đáy quá lâu, thấy giá phe hedge rơi khá sâu nhưng không vào, sau đó bị đảo chiều và lỗ.

## Logic hedge mới

Sau khi đã có first-leg, ví dụ SELL @ 0.49, bot canh BUY. Khi BUY <= target khóa lời, bot KHÔNG chờ vô hạn nữa.

Bot sẽ vào hedge nếu xảy ra một trong các điều kiện:

1. **Giá siêu rẻ**: `hedgeAsk <= SMART_HEDGE_INSTANT_PRICE`
2. **Edge đủ dày**: `currentEdge >= SMART_HEDGE_TAKE_EDGE_CENTS`
3. **Bắt đảo chiều**: giá đã rơi sâu rồi hồi lên `SMART_HEDGE_REBOUND_CENTS`
4. **Không đợi quá lâu**: giá đã đạt target quá `SMART_HEDGE_DECISION_MS` thì khóa luôn
5. **Gần hết giờ**: rescue nếu `SUM <= MAX_RESCUE_SUM`

## ENV khuyên dùng test 1 share

```env
TRADE_SHARES=1
SMART_HEDGE_ENABLED=true
SMART_HEDGE_ENTRY_MAX_PRICE=0.35
SMART_HEDGE_INSTANT_PRICE=0.12
SMART_HEDGE_TAKE_EDGE_CENTS=8
SMART_HEDGE_REBOUND_CENTS=0.5
SMART_HEDGE_DECISION_MS=8000
SMART_HEDGE_MAX_WAIT_MS=20000
GAP_HEDGE_ORDER_TYPE=GTC
GAP_HEDGE_FILL_TIMEOUT_MS=2500
MAX_RESCUE_SUM=1.02
```

Nếu muốn nhanh hơn nữa:

```env
SMART_HEDGE_TAKE_EDGE_CENTS=5
SMART_HEDGE_DECISION_MS=4000
```

Nếu muốn vào ngay khi đạt tổng dưới 1.00, tắt Smart Hedge:

```env
SMART_HEDGE_ENABLED=false
```
