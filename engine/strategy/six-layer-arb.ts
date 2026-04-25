import type { Strategy, StrategyContext, OrderRequest } from "./types.ts";
import type { PipelineStageSnapshot } from "../dashboard-state.ts";
import { Env } from "../../utils/config.ts";

type Side = "UP" | "DOWN";

type ArbConfig = {
  shares: number;
  minEdgeCents: number;
  maxEntrySum: number;
  maxRescueSum: number;
  minRemainingSecs: number;
  scanMs: number;
  fillTimeoutMs: number;
  cooldownMs: number;
  maxArbsPerMarket: number;
  minDepthShares: number;
  orderType: "FOK" | "GTC";
  allowProd: boolean;
};

type PairState = {
  id: number;
  active: boolean;
  startedAt: number;
  upFilled: number;
  downFilled: number;
  upCost: number;
  downCost: number;
  failed: string[];
  hedged: boolean;
  completed: boolean;
  entrySum: number;
};

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(raw.toLowerCase());
}

function readConfig(): ArbConfig {
  const shares = Math.max(
    1,
    Math.floor(numEnv("TRADE_SHARES", numEnv("ORDER_SHARES", numEnv("SHARES", 10)))),
  );
  const minEdgeCents = numEnv("ARB_MIN_EDGE_CENTS", 1);
  const maxEntrySum = numEnv("ARB_MAX_ENTRY_SUM", Number((1 - minEdgeCents / 100).toFixed(4)));
  return {
    shares,
    minEdgeCents,
    maxEntrySum,
    maxRescueSum: numEnv("ARB_MAX_RESCUE_SUM", 1.01),
    minRemainingSecs: Math.max(2, Math.floor(numEnv("ARB_MIN_REMAINING_SECS", 12))),
    scanMs: Math.max(50, Math.floor(numEnv("ARB_SCAN_MS", 120))),
    fillTimeoutMs: Math.max(300, Math.floor(numEnv("ARB_FILL_TIMEOUT_MS", 1800))),
    cooldownMs: Math.max(0, Math.floor(numEnv("ARB_COOLDOWN_MS", 2200))),
    maxArbsPerMarket: Math.max(1, Math.floor(numEnv("ARB_MAX_ARBS_PER_MARKET", 1))),
    minDepthShares: Math.max(1, Math.floor(numEnv("ARB_MIN_DEPTH_SHARES", shares))),
    orderType: (process.env.ARB_ORDER_TYPE === "GTC" ? "GTC" : "FOK"),
    allowProd: boolEnv("ALLOW_SIX_LAYER_ARB_PROD", false),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function pipeline(
  states: Partial<Record<PipelineStageSnapshot["key"], Partial<PipelineStageSnapshot>>>,
): PipelineStageSnapshot[] {
  const labels: Record<PipelineStageSnapshot["key"], string> = {
    scan: "01 Scan",
    detect: "02 Detect",
    validate: "03 Validate",
    size: "04 Size",
    fill: "05 Fill",
    hedge: "06 Hedge",
  };
  const now = nowIso();
  return (["scan", "detect", "validate", "size", "fill", "hedge"] as const).map((key) => ({
    key,
    label: labels[key],
    state: states[key]?.state ?? "idle",
    detail: states[key]?.detail ?? "Chờ dữ liệu",
    updatedAt: states[key]?.updatedAt ?? now,
  }));
}

function sideToken(ctx: StrategyContext, side: Side): string {
  return side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
}

function sharesAtBest(price: number, liquidity: number): number {
  return price > 0 ? liquidity / price : 0;
}

function fmtCents(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "--";
  return `${v.toFixed(2)}¢`;
}

function pushIdle(ctx: StrategyContext, cfg: ArbConfig, detail = "Đang quét orderbook") {
  ctx.setDiagnostics({
    pipeline: pipeline({
      scan: { state: "watch", detail },
      detect: { state: "watch", detail: `Chờ YES + NO <= ${cfg.maxEntrySum.toFixed(2)}` },
      validate: { state: "idle", detail: "Chờ edge thật" },
      size: { state: "idle", detail: `${cfg.shares} shares / cycle` },
      fill: { state: "idle", detail: "Chưa gửi cặp lệnh" },
      hedge: { state: "idle", detail: "Đợi fill lệch" },
    }),
    arb: {
      minEdgeCents: cfg.minEdgeCents,
      maxEntrySum: cfg.maxEntrySum,
      targetShares: cfg.shares,
      lastAction: detail,
      riskNote: "Không phải free 100%: rủi ro chính là chỉ fill một bên hoặc trượt giá.",
    },
  });
}

async function placeExitSell(ctx: StrategyContext, side: Side, shares: number, reason: string) {
  const bid = ctx.orderBook.bestBidInfo(side);
  const tokenId = sideToken(ctx, side);
  const price = bid?.price ?? 0.01;
  ctx.log(`[${ctx.slug}] arb: hedge SELL ${side} ${shares.toFixed(4)} @ ${price} | ${reason}`, "yellow");
  ctx.postOrders([
    {
      req: {
        tokenId,
        action: "sell",
        price,
        shares,
        orderType: "GTC",
      },
      expireAtMs: ctx.slotEndMs,
      onFilled(filledShares) {
        ctx.log(`[${ctx.slug}] arb: hedge SELL ${side} filled ${filledShares.toFixed(4)} @ ${price}`, "green");
      },
      onExpired() {
        ctx.log(`[${ctx.slug}] arb: hedge SELL ${side} expired — emergency selling`, "red");
        const sellIds = ctx.pendingOrders
          .filter((o) => o.action === "sell" && o.tokenId === tokenId)
          .map((o) => o.orderId);
        if (sellIds.length > 0) void ctx.emergencySells(sellIds);
      },
      onFailed(failReason) {
        ctx.log(`[${ctx.slug}] arb: hedge SELL ${side} failed (${failReason})`, "red");
      },
    },
  ]);
}

function tryRescueMissingSide(
  ctx: StrategyContext,
  cfg: ArbConfig,
  pair: PairState,
  missingSide: Side,
  missingShares: number,
  filledAvgCost: number,
): boolean {
  const ask = ctx.orderBook.bestAskInfo(missingSide);
  if (!ask) return false;
  const rescueSum = Number((filledAvgCost + ask.price).toFixed(4));
  const depthShares = sharesAtBest(ask.price, ask.liquidity);
  if (rescueSum > cfg.maxRescueSum || depthShares < missingShares) return false;

  const tokenId = sideToken(ctx, missingSide);
  const exitSide: Side = missingSide === "UP" ? "DOWN" : "UP";
  pair.hedged = true;
  ctx.log(
    `[${ctx.slug}] arb: rescue BUY ${missingSide} ${missingShares.toFixed(4)} @ ${ask.price} | rescueSum=${rescueSum}`,
    "yellow",
  );

  ctx.postOrders([
    {
      req: {
        tokenId,
        action: "buy",
        price: ask.price,
        shares: missingShares,
        orderType: "FOK",
      },
      expireAtMs: Date.now() + cfg.fillTimeoutMs,
      onFilled(filledShares) {
        if (missingSide === "UP") {
          pair.upFilled += filledShares;
          pair.upCost += ask.price * filledShares;
        } else {
          pair.downFilled += filledShares;
          pair.downCost += ask.price * filledShares;
        }
        pair.completed = true;
        pair.active = false;
        ctx.log(`[${ctx.slug}] arb: rescue BUY ${missingSide} filled ${filledShares.toFixed(4)} @ ${ask.price}`, "green");
      },
      onFailed(reason) {
        pair.failed.push(`rescue ${missingSide}: ${reason}`);
        pair.active = false;
        ctx.log(`[${ctx.slug}] arb: rescue BUY ${missingSide} failed (${reason}) — selling ${exitSide}`, "red");
        void placeExitSell(ctx, exitSide, missingShares, `rescue ${missingSide} failed`);
      },
      onExpired() {
        pair.failed.push(`rescue ${missingSide} expired`);
        pair.active = false;
        ctx.log(`[${ctx.slug}] arb: rescue BUY ${missingSide} expired — selling ${exitSide}`, "red");
        void placeExitSell(ctx, exitSide, missingShares, `rescue ${missingSide} expired`);
      },
    },
  ]);
  return true;
}

function hedgeIfUnbalanced(ctx: StrategyContext, cfg: ArbConfig, pair: PairState) {
  if (!pair.active || pair.hedged) return;
  if (Date.now() - pair.startedAt < cfg.fillTimeoutMs) return;

  const up = pair.upFilled;
  const down = pair.downFilled;
  if (up > 0 && down > 0 && Math.abs(up - down) < 0.000001) {
    pair.completed = true;
    pair.active = false;
    return;
  }

  const onlyUp = up > 0 && down <= 0;
  const onlyDown = down > 0 && up <= 0;
  const partialUp = up > down && down > 0;
  const partialDown = down > up && up > 0;

  if (onlyUp || partialUp) {
    const missing = Number((up - down).toFixed(4));
    const avg = up > 0 ? pair.upCost / up : pair.entrySum / 2;
    ctx.setDiagnostics({
      pipeline: pipeline({
        scan: { state: "pass", detail: "Đã có fill một bên" },
        detect: { state: "warn", detail: "Pair bị lệch UP > DOWN" },
        validate: { state: "warn", detail: "Kích hoạt rescue/hedge" },
        size: { state: "pass", detail: `Missing DOWN ${missing.toFixed(2)}` },
        fill: { state: "warn", detail: "Chỉ fill một phần" },
        hedge: { state: "warn", detail: "Đang mua DOWN hoặc bán UP" },
      }),
      arb: { lastAction: "Hedge imbalance UP", lastTrigger: pair.failed.join(" | ") || null },
    });
    if (!tryRescueMissingSide(ctx, cfg, pair, "DOWN", missing, avg)) {
      pair.hedged = true;
      pair.active = false;
      void placeExitSell(ctx, "UP", missing, "không mua được DOWN ở rescueSum cho phép");
    }
    return;
  }

  if (onlyDown || partialDown) {
    const missing = Number((down - up).toFixed(4));
    const avg = down > 0 ? pair.downCost / down : pair.entrySum / 2;
    ctx.setDiagnostics({
      pipeline: pipeline({
        scan: { state: "pass", detail: "Đã có fill một bên" },
        detect: { state: "warn", detail: "Pair bị lệch DOWN > UP" },
        validate: { state: "warn", detail: "Kích hoạt rescue/hedge" },
        size: { state: "pass", detail: `Missing UP ${missing.toFixed(2)}` },
        fill: { state: "warn", detail: "Chỉ fill một phần" },
        hedge: { state: "warn", detail: "Đang mua UP hoặc bán DOWN" },
      }),
      arb: { lastAction: "Hedge imbalance DOWN", lastTrigger: pair.failed.join(" | ") || null },
    });
    if (!tryRescueMissingSide(ctx, cfg, pair, "UP", missing, avg)) {
      pair.hedged = true;
      pair.active = false;
      void placeExitSell(ctx, "DOWN", missing, "không mua được UP ở rescueSum cho phép");
    }
    return;
  }

  pair.completed = true;
  pair.active = false;
}

export const sixLayerArb: Strategy = async (ctx) => {
  const cfg = readConfig();

  if (Env.get("PROD") && !cfg.allowProd) {
    ctx.log(
      "[six-layer-arb] Production đang khóa. Test SIM trước; muốn chạy tiền thật set ALLOW_SIX_LAYER_ARB_PROD=true và DASHBOARD_ALLOW_PROD_START=true.",
      "red",
    );
    process.exit(1);
  }

  const releaseLock = ctx.hold();
  let released = false;
  let trades = 0;
  let pairId = 0;
  let activePair: PairState | null = null;
  let lastTradeAt = 0;
  let totalCapitalUsed = 0;
  let lastLoggedWindow = 0;

  const release = () => {
    if (!released) {
      released = true;
      releaseLock();
    }
  };

  pushIdle(ctx, cfg, "6-layer scanner ready");

  const tick = () => {
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);
    const marketOpen = Date.now() >= ctx.slotStartMs;

    if (remaining <= 0) {
      clearInterval(timer);
      release();
      return;
    }

    if (!marketOpen) {
      pushIdle(ctx, cfg, `Market chưa mở, còn ${Math.max(0, Math.floor((ctx.slotStartMs - Date.now()) / 1000))}s`);
      return;
    }

    hedgeIfUnbalanced(ctx, cfg, activePair ?? ({ active: false } as PairState));

    if (activePair?.active) {
      ctx.setDiagnostics({
        pipeline: pipeline({
          scan: { state: "pass", detail: "Đang monitor pair đã gửi" },
          detect: { state: "pass", detail: `Entry sum ${activePair.entrySum.toFixed(4)}` },
          validate: { state: "pass", detail: "Đã qua validate" },
          size: { state: "pass", detail: `${cfg.shares} shares` },
          fill: { state: "watch", detail: `UP ${activePair.upFilled.toFixed(2)} / DOWN ${activePair.downFilled.toFixed(2)}` },
          hedge: { state: "watch", detail: "Chờ đủ 2 bên" },
        }),
        arb: {
          trades,
          capitalUsed: Number(totalCapitalUsed.toFixed(4)),
          fillLatencyMs: Date.now() - activePair.startedAt,
          lastAction: "Waiting pair fill",
        },
      });
      return;
    }

    if (trades >= cfg.maxArbsPerMarket) {
      clearInterval(timer);
      ctx.setDiagnostics({
        pipeline: pipeline({
          scan: { state: "pass", detail: "Đủ số cycle cho market này" },
          detect: { state: "idle", detail: "Không mở thêm" },
          validate: { state: "idle", detail: "Đã khóa entry mới" },
          size: { state: "idle", detail: `${trades}/${cfg.maxArbsPerMarket} cycles` },
          fill: { state: "pass", detail: "Đã hoàn tất cycle" },
          hedge: { state: "idle", detail: "Không có lệch active" },
        }),
        arb: { trades, capitalUsed: Number(totalCapitalUsed.toFixed(4)), lastAction: "Max cycles reached" },
      });
      release();
      return;
    }

    if (remaining < cfg.minRemainingSecs) {
      clearInterval(timer);
      ctx.setDiagnostics({
        pipeline: pipeline({
          scan: { state: "warn", detail: `Còn ${remaining}s, ngừng vào mới` },
          detect: { state: "idle", detail: "Market sắp close" },
          validate: { state: "idle", detail: "Không đủ thời gian hedge" },
          size: { state: "idle", detail: "Không mở size mới" },
          fill: { state: "idle", detail: "Không gửi lệnh" },
          hedge: { state: "idle", detail: "Không có pair active" },
        }),
        arb: { lastAction: "Stop new entries near close", trades },
      });
      release();
      return;
    }

    if (Date.now() - lastTradeAt < cfg.cooldownMs) {
      pushIdle(ctx, cfg, "Cooldown sau cycle trước");
      return;
    }

    const upAsk = ctx.orderBook.bestAskInfo("UP");
    const downAsk = ctx.orderBook.bestAskInfo("DOWN");
    const upBid = ctx.orderBook.bestBidInfo("UP");
    const downBid = ctx.orderBook.bestBidInfo("DOWN");

    if (!upAsk || !downAsk) {
      pushIdle(ctx, cfg, "Đang chờ đủ YES/NO ask");
      return;
    }

    const sum = Number((upAsk.price + downAsk.price).toFixed(4));
    const edge = Number((1 - sum).toFixed(4));
    const edgeCents = Number((edge * 100).toFixed(2));
    const upDepth = sharesAtBest(upAsk.price, upAsk.liquidity);
    const downDepth = sharesAtBest(downAsk.price, downAsk.liquidity);
    const depthShares = Math.floor(Math.min(upDepth, downDepth));
    const size = Math.min(cfg.shares, depthShares);
    const validEdge = sum <= cfg.maxEntrySum && edgeCents >= cfg.minEdgeCents;
    const validDepth = depthShares >= cfg.minDepthShares && size >= 1;
    const capitalNeeded = Number((sum * size).toFixed(4));

    ctx.setDiagnostics({
      pipeline: pipeline({
        scan: { state: "pass", detail: "YES/NO orderbook live" },
        detect: {
          state: validEdge ? "pass" : "watch",
          detail: `YES ${upAsk.price.toFixed(2)} + NO ${downAsk.price.toFixed(2)} = ${sum.toFixed(2)} | edge ${fmtCents(edgeCents)}`,
        },
        validate: {
          state: validEdge && validDepth ? "pass" : validEdge ? "warn" : "watch",
          detail: validEdge && validDepth
            ? "Edge + depth đạt chuẩn"
            : `Need edge >= ${cfg.minEdgeCents}¢, depth >= ${cfg.minDepthShares}`,
        },
        size: {
          state: validDepth ? "pass" : "warn",
          detail: `target ${cfg.shares}, executable ${Math.max(0, size)} shares`,
        },
        fill: { state: "idle", detail: "Chờ validate" },
        hedge: { state: "idle", detail: "Không cần hedge" },
      }),
      arb: {
        yesAsk: upAsk.price,
        noAsk: downAsk.price,
        yesBid: upBid?.price ?? null,
        noBid: downBid?.price ?? null,
        yesLiquidity: upAsk.liquidity,
        noLiquidity: downAsk.liquidity,
        sum,
        edge,
        edgeCents,
        minEdgeCents: cfg.minEdgeCents,
        maxEntrySum: cfg.maxEntrySum,
        executable: validEdge && validDepth,
        targetShares: cfg.shares,
        depthShares,
        capitalNeeded,
        capitalUsed: Number(totalCapitalUsed.toFixed(4)),
        trades,
        lastAction: validEdge && validDepth ? "Executable arb detected" : "Scanning",
        riskNote: "Nếu chỉ fill một bên, engine sẽ rescue side còn thiếu hoặc bán thoát bên đã fill.",
      },
    });

    if (!validEdge || !validDepth) {
      if (Date.now() - lastLoggedWindow > 3000) {
        lastLoggedWindow = Date.now();
        ctx.log(`[${ctx.slug}] arb: scan sum=${sum.toFixed(4)} edge=${edgeCents.toFixed(2)}¢ depth=${depthShares}`, "dim");
      }
      return;
    }

    const id = ++pairId;
    activePair = {
      id,
      active: true,
      startedAt: Date.now(),
      upFilled: 0,
      downFilled: 0,
      upCost: 0,
      downCost: 0,
      failed: [],
      hedged: false,
      completed: false,
      entrySum: sum,
    };
    lastTradeAt = Date.now();
    trades++;

    ctx.log(
      `[${ctx.slug}] six-layer arb: DETECTED YES+NO=${sum.toFixed(4)} edge=${edgeCents.toFixed(2)}¢ size=${size} capital=$${capitalNeeded.toFixed(2)}`,
      "cyan",
    );

    ctx.setDiagnostics({
      pipeline: pipeline({
        scan: { state: "pass", detail: "Orderbook window found" },
        detect: { state: "pass", detail: `Edge ${edgeCents.toFixed(2)}¢` },
        validate: { state: "pass", detail: "Edge/depth OK" },
        size: { state: "pass", detail: `${size} paired shares` },
        fill: { state: "watch", detail: "Đang gửi BUY YES + BUY NO" },
        hedge: { state: "idle", detail: "Chưa cần hedge" },
      }),
      arb: {
        executable: true,
        targetShares: size,
        capitalNeeded,
        trades,
        lastAction: "Submit paired FOK buys",
        lastTrigger: `sum=${sum.toFixed(4)}, edge=${edgeCents.toFixed(2)}¢`,
      },
    });

    const expireAtMs = cfg.orderType === "FOK" ? Date.now() + cfg.fillTimeoutMs : ctx.slotEndMs;
    const orders: OrderRequest[] = [
      {
        req: {
          tokenId: ctx.clobTokenIds[0],
          action: "buy",
          price: upAsk.price,
          shares: size,
          orderType: cfg.orderType,
        },
        expireAtMs,
        onFilled(filledShares) {
          if (!activePair || activePair.id !== id) return;
          activePair.upFilled += filledShares;
          activePair.upCost += upAsk.price * filledShares;
          totalCapitalUsed += upAsk.price * filledShares;
          ctx.log(`[${ctx.slug}] arb: BUY YES/UP filled @ ${upAsk.price} (${filledShares} shares)`, "green");
        },
        onFailed(reason) {
          if (!activePair || activePair.id !== id) return;
          activePair.failed.push(`UP ${reason}`);
          ctx.log(`[${ctx.slug}] arb: BUY YES/UP failed (${reason})`, "red");
        },
        onExpired() {
          if (!activePair || activePair.id !== id) return;
          activePair.failed.push("UP expired");
          ctx.log(`[${ctx.slug}] arb: BUY YES/UP expired`, "yellow");
        },
      },
      {
        req: {
          tokenId: ctx.clobTokenIds[1],
          action: "buy",
          price: downAsk.price,
          shares: size,
          orderType: cfg.orderType,
        },
        expireAtMs,
        onFilled(filledShares) {
          if (!activePair || activePair.id !== id) return;
          activePair.downFilled += filledShares;
          activePair.downCost += downAsk.price * filledShares;
          totalCapitalUsed += downAsk.price * filledShares;
          ctx.log(`[${ctx.slug}] arb: BUY NO/DOWN filled @ ${downAsk.price} (${filledShares} shares)`, "green");
        },
        onFailed(reason) {
          if (!activePair || activePair.id !== id) return;
          activePair.failed.push(`DOWN ${reason}`);
          ctx.log(`[${ctx.slug}] arb: BUY NO/DOWN failed (${reason})`, "red");
        },
        onExpired() {
          if (!activePair || activePair.id !== id) return;
          activePair.failed.push("DOWN expired");
          ctx.log(`[${ctx.slug}] arb: BUY NO/DOWN expired`, "yellow");
        },
      },
    ];

    ctx.postOrders(orders);
  };

  const timer = setInterval(tick, cfg.scanMs);
  tick();

  return () => {
    clearInterval(timer);
    release();
  };
};
