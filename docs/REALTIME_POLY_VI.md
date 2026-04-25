# Chế độ realtime đồng thời với Polymarket

Bản này đã đổi mặc định `slotOffset=0` để dashboard/bot bám theo **market Polymarket hiện tại** thay vì chuẩn bị market kế tiếp.

## Ý nghĩa Slot offset

```text
0 = current slot / market đang chạy trên Polymarket
1 = market kế tiếp
2 = market sau nữa
```

Nếu muốn thấy `Price to beat` và `Gap` ngay, dùng:

```text
Slot offset = 0
```

## Chạy bằng dashboard

```powershell
bun run dashboard
```

Mở:

```text
http://localhost:3000
```

Sau đó bấm **START**. Mặc định START sẽ dùng `slotOffset=0`.

## Chạy bằng terminal

```powershell
bun run index.ts --strategy late-entry --slot-offset 0 --rounds 20 --always-log
```

## Không xóa dữ liệu cũ

Dashboard giữ lại:

- trade feed cũ
- live log gần nhất
- đường cong số dư

Muốn xóa lịch sử thì xóa file:

```text
state/dashboard.json
```

Hoặc set:

```env
DASHBOARD_KEEP_HISTORY=false
```

## Update ngay khi có lệnh

Bản này flush dashboard ngay khi có:

- BUY / SELL
- filled
- resolved
- balance thay đổi

Nên khi lệnh xong, web sẽ cập nhật gần như tức thì.
