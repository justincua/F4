# CuaX Trader V9 - Deploy Safe Slot Guard

Bản này sửa lỗi sau khi Railway redeploy xong bot nhảy vào phiên đang chạy dở, ví dụ còn 60 giây.

## Logic mới

- `START_ONLY_NEW_SLOT=true`: nếu service start khi market hiện tại đã mở quá `START_GRACE_SECS`, bot bỏ qua slot đó.
- `ENTRY_MAX_OPENED_SECS=45`: chỉ cho entry mới trong 45 giây đầu phiên.
- `ENTRY_MIN_REMAINING_SECS=240`: chỉ cho entry nếu còn ít nhất 240 giây.
- Nếu đã có first-leg, bot vẫn được hedge/rescue để thoát, không bị chặn bởi entry guard.

## ENV quan trọng

```env
START_ONLY_NEW_SLOT=true
START_GRACE_SECS=8
ENTRY_MAX_OPENED_SECS=45
ENTRY_MIN_REMAINING_SECS=240
GAP_FIRST_ENTRY_WINDOW_SECS=45
GAP_MIN_REMAINING_SECS=240
SMART_HEDGE_ENABLED=false
MIN_LOCK_EDGE_CENTS=0
ARB_MAX_ENTRY_SUM=0.999
```

## Kỳ vọng log

Khi redeploy giữa phiên cũ:

```txt
gap-arb: Bỏ qua phiên đang chạy dở sau deploy: slot đã mở 240s, còn 60s. Chờ phiên mới.
```
