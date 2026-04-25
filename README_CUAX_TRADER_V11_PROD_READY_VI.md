# CuaX Trader V11 PROD READY - Pixel Pro 0.90

Bản này giữ UI Pixel Pro realtime/mobile và cấu hình sẵn cho chạy thật trên Railway.

## Logic chính

- `GAP_INVERT_SIGNAL=true`: GAP BUY thì mua SELL/DOWN, GAP SELL thì mua BUY/UP.
- `PROFIT_MAX_SUM=0.90`: chỉ lock khi BUY + SELL <= 0.90.
- `MIN_LOCK_EDGE_CENTS=10`: tương đương lợi nhuận lý thuyết tối thiểu 10 cent/share.
- `START_ONLY_NEW_SLOT=true`: redeploy xong không nhảy vào phiên cũ gần hết giờ.
- `TRADE_SHARES=1`: test PROD bằng 1 share trước.

## Chạy Railway

1. Upload source lên GitHub.
2. Railway deploy repo.
3. Dán full ENV trong `.env.sample` vào Variables.
4. Điền 5 key Polymarket thật.
5. Redeploy.

## Cảnh báo

Không commit `.env` có `PRIVATE_KEY` lên GitHub. PROD có rủi ro partial fill, slippage, orderbook đổi nhanh, settlement và lỗi API. Chạy 1 share trước để kiểm tra log/fill.
