import type { Strategy, StrategyContext, OrderRequest } from "./types.ts";
import type { PipelineStageSnapshot } from "../dashboard-state.ts";
import { Env } from "../../utils/config.ts";

type Side = "UP" | "DOWN";
type VnSide = "BUY" | "SELL";
type BotMode = "IDLE" | "PURE_ARB" | "GAP_FIRST_LEG" | "WAIT_HEDGE" | "LOCKED" | "RESCUE" | "HOLD_ONE_SIDE";

type HybridConfig = {
  shares: number;
  minLockEdgeCents: number;
  maxEntrySum: number;
  profitLockEnabled: boolean;
  profitMaxSum: number;
  firstLegMaxPrice: number;
  firstEntryWindowSecs: number;
  minRemainingSecs: number;
  scanMs: number;
  fillTimeoutMs: number;
  hedgeFillTimeoutMs: number;
  maxHoldFirstLegMs: number;
  rescueBeforeCloseSecs: number;
  maxRescueSum: number;
  cooldownMs: number;
  maxCyclesPerMarket: number;
  minDepthShares: number;
  minHedgeShares: number;
  minAbsGap: number;
  hedgeSlippageCents: number;
  oneSideHoldEnabled: boolean;
  oneSideHoldAboveSum: number;
  oneSideHoldPermanent: boolean;
  smartHedgeEnabled: boolean;
  smartHedgeEntryMaxPrice: number;
  smartHedgeInstantPrice: number;
  smartHedgeTakeEdgeCents: number;
  smartHedgeReboundCents: number;
  smartHedgeDecisionMs: number;
  smartHedgeMaxWaitMs: number;
  allowPartialHedge: boolean;
  pureArbEnabled: boolean;
  gapSignalEnabled: boolean;
  gapInvertSignal: boolean;
  ignoreDepthForGtc: boolean;
  startOnlyNewSlot: boolean;
  startGraceSecs: number;
  entryMaxOpenedSecs: number;
  entryMinRemainingSecs: number;
  allowProd: boolean;
  orderType: "FOK" | "GTC";
  firstOrderType: "FOK" | "GTC";
  hedgeOrderType: "FOK" | "GTC";
};

type FirstLeg = {
  id: number;
  side: Side;
  signalSide: Side;
  entryPrice: number;
  shares: number;
  filledShares: number;
  cost: number;
  placedAtMs: number;
  filledAtMs: number | null;
  hedgeShares: number;
  hedgeCost: number;
  status: "placing" | "filled" | "locked" | "rescue" | "closed" | "failed";
  reason: string | null;
  lowestHedgeAsk: number | null;
  lastHedgeAsk: number | null;
  firstLockSeenAtMs: number | null;
  holdOneSideActivated: boolean;
  holdOneSideAtMs: number | null;
  holdOneSideReason: string | null;
};

type PairLeg = {
  id: number;
  startedAt: number;
  upFilled: number;
  downFilled: number;
  upCost: number;
  downCost: number;
  status: "placing" | "locked" | "rescue" | "failed";
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

function readConfig(): HybridConfig {
  const shares = Math.max(
    1,
    Math.floor(numEnv("TRADE_SHARES", numEnv("ORDER_SHARES", numEnv("SHARES", 10)))),
  );
  const minLockEdgeCents = numEnv("MIN_LOCK_EDGE_CENTS", numEnv("ARB_MIN_EDGE_CENTS", 1));
  const maxEntrySum = numEnv("ARB_MAX_ENTRY_SUM", Number((1 - minLockEdgeCents / 100).toFixed(4)));
  return {
    shares,
    minLockEdgeCents,
    maxEntrySum,
    profitLockEnabled: boolEnv("PROFIT_LOCK_ENABLED", true),
    profitMaxSum: numEnv("PROFIT_MAX_SUM", numEnv("TAKE_PROFIT_MAX_SUM", maxEntrySum)),
    firstLegMaxPrice: numEnv("FIRST_LEG_MAX_PRICE", 0.49),
    firstEntryWindowSecs: Math.max(5, Math.floor(numEnv("GAP_FIRST_ENTRY_WINDOW_SECS", 300))),
    minRemainingSecs: Math.max(5, Math.floor(numEnv("GAP_MIN_REMAINING_SECS", numEnv("ARB_MIN_REMAINING_SECS", 18)))),
    scanMs: Math.max(30, Math.floor(numEnv("GAP_SCAN_MS", numEnv("ARB_SCAN_MS", 100)))),
    fillTimeoutMs: Math.max(250, Math.floor(numEnv("GAP_FIRST_FILL_TIMEOUT_MS", numEnv("ARB_FILL_TIMEOUT_MS", 1500)))),
    hedgeFillTimeoutMs: Math.max(250, Math.floor(numEnv("GAP_HEDGE_FILL_TIMEOUT_MS", numEnv("ARB_FILL_TIMEOUT_MS", 1500)))),
    maxHoldFirstLegMs: Math.max(3000, Math.floor(numEnv("MAX_HOLD_FIRST_LEG_MS", 240000))),
    rescueBeforeCloseSecs: Math.max(3, Math.floor(numEnv("RESCUE_BEFORE_CLOSE_SECS", 18))),
    maxRescueSum: numEnv("MAX_RESCUE_SUM", numEnv("ARB_MAX_RESCUE_SUM", 1.02)),
    cooldownMs: Math.max(0, Math.floor(numEnv("GAP_COOLDOWN_MS", 1000))),
    maxCyclesPerMarket: Math.max(1, Math.floor(numEnv("GAP_MAX_CYCLES_PER_MARKET", numEnv("ARB_MAX_ARBS_PER_MARKET", 1)))),
    minDepthShares: Math.max(1, Math.floor(numEnv("GAP_MIN_DEPTH_SHARES", numEnv("ARB_MIN_DEPTH_SHARES", shares)))),
    minHedgeShares: Math.max(1, Math.floor(numEnv("GAP_MIN_HEDGE_SHARES", 1))),
    minAbsGap: Math.max(0, numEnv("GAP_MIN_ABS_PRICE", 0)),
    hedgeSlippageCents: Math.max(0, numEnv("GAP_HEDGE_SLIPPAGE_CENTS", 1)),
    // V13: nếu tổng giá first-leg + hedge đối diện vượt ngưỡng này,
    // bot KHÔNG hedge/rescue nữa mà giữ 1 phe theo yêu cầu.
    oneSideHoldEnabled: boolEnv("ONE_SIDE_HOLD_ENABLED", true),
    oneSideHoldAboveSum: numEnv("ONE_SIDE_HOLD_ABOVE_SUM", 1.03),
    oneSideHoldPermanent: boolEnv("ONE_SIDE_HOLD_PERMANENT", true),
    smartHedgeEnabled: boolEnv("SMART_HEDGE_ENABLED", true),
    smartHedgeEntryMaxPrice: numEnv("SMART_HEDGE_ENTRY_MAX_PRICE", 0.35),
    smartHedgeInstantPrice: numEnv("SMART_HEDGE_INSTANT_PRICE", 0.12),
    smartHedgeTakeEdgeCents: Math.max(0, numEnv("SMART_HEDGE_TAKE_EDGE_CENTS", 8)),
    smartHedgeReboundCents: Math.max(0, numEnv("SMART_HEDGE_REBOUND_CENTS", 0.5)),
    smartHedgeDecisionMs: Math.max(500, Math.floor(numEnv("SMART_HEDGE_DECISION_MS", 8000))),
    smartHedgeMaxWaitMs: Math.max(1000, Math.floor(numEnv("SMART_HEDGE_MAX_WAIT_MS", 20000))),
    allowPartialHedge: boolEnv("ALLOW_PARTIAL_HEDGE", true),
    pureArbEnabled: boolEnv("PURE_ARB_ENABLED", true),
    gapSignalEnabled: boolEnv("GAP_SIGNAL_ENABLED", true),
    // V8: bật/tắt kiểu đảo GAP. false = BUY ra BUY, SELL ra SELL. true = BUY ra SELL, SELL ra BUY.
    gapInvertSignal: boolEnv("GAP_INVERT_SIGNAL", false),
    // V8: nếu dùng GTC thì không chặn lệnh chỉ vì depth snapshot mỏng; đặt lệnh chờ tại giá tốt.
    ignoreDepthForGtc: boolEnv("GAP_IGNORE_DEPTH_FOR_GTC", true),

    // V9: chống redeploy xong nhảy vào phiên đang chạy dở / còn ít giây.
    // START_ONLY_NEW_SLOT=true: nếu service start khi slot đã mở quá START_GRACE_SECS thì bỏ slot đó.
    startOnlyNewSlot: boolEnv("START_ONLY_NEW_SLOT", boolEnv("SKIP_OPEN_SLOT_ON_START", true)),
    startGraceSecs: Math.max(0, Math.floor(numEnv("START_GRACE_SECS", numEnv("SKIP_OPEN_SLOT_AFTER_SECS", 8)))),
    // Entry mới chỉ cho phép trong N giây đầu phiên và còn đủ thời gian để hedge.
    entryMaxOpenedSecs: Math.max(1, Math.floor(numEnv("ENTRY_MAX_OPENED_SECS", numEnv("GAP_FIRST_ENTRY_WINDOW_SECS", 45)))),
    entryMinRemainingSecs: Math.max(1, Math.floor(numEnv("ENTRY_MIN_REMAINING_SECS", numEnv("GAP_MIN_REMAINING_SECS", 240)))),
    allowProd: boolEnv("ALLOW_GAP_SIX_LAYER_ARB_PROD", false),
    orderType: process.env.GAP_ORDER_TYPE === "FOK" ? "FOK" : "GTC",
    firstOrderType: process.env.GAP_FIRST_ORDER_TYPE === "FOK" ? "FOK" : (process.env.GAP_ORDER_TYPE === "FOK" ? "FOK" : "GTC"),
    hedgeOrderType: process.env.GAP_HEDGE_ORDER_TYPE === "FOK" ? "FOK" : "GTC",
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function pipeline(
  states: Partial<Record<PipelineStageSnapshot["key"], Partial<PipelineStageSnapshot>>>,
): PipelineStageSnapshot[] {
  const labels: Record<PipelineStageSnapshot["key"], string> = {
    scan: "01 Quét",
    detect: "02 Bắt tín hiệu",
    validate: "03 Lọc điều kiện",
    size: "04 Tính shares",
    fill: "05 Vào lệnh",
    hedge: "06 Khóa/Hedge",
  };
  const now = nowIso();
  return (["scan", "detect", "validate", "size", "fill", "hedge"] as const).map((key) => ({
    key,
    label: labels[key],
    state: states[key]?.state ?? "idle",
    detail: states[key]?.detail ?? "Đang chờ dữ liệu",
    updatedAt: states[key]?.updatedAt ?? now,
  }));
}

function sideToken(ctx: StrategyContext, side: Side): string {
  return side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
}

function opposite(side: Side): Side {
  return side === "UP" ? "DOWN" : "UP";
}

function vnSide(side: Side): VnSide {
  return side === "UP" ? "BUY" : "SELL";
}

function prettySide(side: Side): string {
  return side === "UP" ? "BUY / UP" : "SELL / DOWN";
}

function signalFromGap(gap: number | null): Side | null {
  if (gap === null) return null;
  if (gap > 0) return "UP";
  if (gap < 0) return "DOWN";
  return null;
}

function sharesAtBest(price: number, liquidity: number): number {
  return price > 0 ? liquidity / price : 0;
}

function fmtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return value.toFixed(2);
}

function fmtCents(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${value.toFixed(2)}¢`;
}

function lockSumLimit(cfg: HybridConfig): number {
  const edgeLimit = 1 - cfg.minLockEdgeCents / 100;
  // V10: profit lock ưu tiên tổng BUY+SELL < 1.00.
  // PROFIT_MAX_SUM=0.999 nghĩa là dưới 1.00 là bắn hedge ngay,
  // còn MIN_LOCK_EDGE_CENTS vẫn có thể dùng để đòi edge dày hơn nếu muốn.
  return Number(Math.min(edgeLimit, cfg.profitMaxSum).toFixed(4));
}

function lockTarget(firstPrice: number, cfg: HybridConfig): number {
  return Number((lockSumLimit(cfg) - firstPrice).toFixed(4));
}

function rescueTarget(firstPrice: number, cfg: HybridConfig): number {
  return Number((cfg.maxRescueSum - firstPrice).toFixed(4));
}

function limitBuyPrice(bestAsk: number, maxAllowed: number, cfg: HybridConfig): number {
  const slipped = bestAsk + cfg.hedgeSlippageCents / 100;
  return Number(Math.min(maxAllowed, slipped).toFixed(4));
}

function hedgeQty(needShares: number, depthShares: number, cfg: HybridConfig, ignoreDepth = false): number {
  if (needShares <= 0) return 0;

  // V3 FIX: khi đã có first-leg, ưu tiên khóa 2 phe. Với GTC/limit hedge,
  // không được bỏ lỡ chỉ vì snapshot depth hiện tại mỏng hoặc vừa nhảy.
  // Nếu ignoreDepth=true, đặt luôn đúng số shares còn thiếu tại giá target.
  if (ignoreDepth) {
    const qty = needShares;
    return qty >= cfg.minHedgeShares ? Number(qty.toFixed(4)) : 0;
  }

  if (!cfg.allowPartialHedge) return depthShares + 1e-9 >= needShares ? needShares : 0;
  const qty = Math.min(needShares, Math.floor(depthShares));
  return qty >= cfg.minHedgeShares ? Number(qty.toFixed(4)) : 0;
}

function pushStatus(params: {
  ctx: StrategyContext;
  cfg: HybridConfig;
  mode?: BotMode;
  detail: string;
  gapSignal?: Side | null;
  firstLeg?: FirstLeg | null;
  trades: number;
  capitalUsed: number;
  pureSum?: number | null;
  pureEdgeCents?: number | null;
}) {
  const { ctx, cfg, mode = "IDLE", detail, gapSignal = null, firstLeg = null, trades, capitalUsed, pureSum = null, pureEdgeCents = null } = params;
  const hedgeSide = firstLeg ? opposite(firstLeg.side) : null;
  const hedgeMaxPrice = firstLeg && firstLeg.filledShares > 0 ? lockTarget(firstLeg.cost / firstLeg.filledShares, cfg) : null;
  ctx.setDiagnostics({
    pipeline: pipeline({
      scan: { state: "watch", detail },
      detect: {
        state: gapSignal ? "pass" : pureSum !== null && pureSum <= cfg.maxEntrySum ? "pass" : "watch",
        detail: gapSignal
          ? `GAP SIDE = ${vnSide(gapSignal)} → first-leg ${cfg.gapInvertSignal ? "ngược" : "cùng"} là ${prettySide(cfg.gapInvertSignal ? opposite(gapSignal) : gapSignal)}`
          : pureSum !== null
            ? `Pure SUM=${pureSum.toFixed(2)} | edge=${fmtCents(pureEdgeCents)}`
            : "Chờ GAP SIDE hoặc pure arb",
      },
      validate: {
        state: firstLeg ? "pass" : "watch",
        detail: firstLeg
          ? `First ${prettySide(firstLeg.side)} @ ${firstLeg.entryPrice.toFixed(2)}`
          : `First-leg <= ${cfg.firstLegMaxPrice.toFixed(2)}, chốt khi SUM <= ${lockSumLimit(cfg).toFixed(4)}`,
      },
      size: { state: "watch", detail: `${cfg.shares} shares / cycle` },
      fill: {
        state: firstLeg ? (firstLeg.filledShares > 0 ? "pass" : "watch") : "idle",
        detail: firstLeg
          ? `${prettySide(firstLeg.side)} filled ${firstLeg.filledShares.toFixed(2)}/${firstLeg.shares}`
          : "Chưa vào first-leg",
      },
      hedge: {
        state: firstLeg?.status === "locked" ? "pass" : firstLeg ? "watch" : "idle",
        detail: firstLeg
          ? `Canh ${hedgeSide ? prettySide(hedgeSide) : "phe đối diện"} <= ${fmtPrice(hedgeMaxPrice)} để SUM < 1.00`
          : "Chờ có first-leg",
      },
    }),
    arb: {
      minEdgeCents: cfg.minLockEdgeCents,
      maxEntrySum: cfg.maxEntrySum,
      oneSideHoldEnabled: cfg.oneSideHoldEnabled,
      oneSideHoldAboveSum: cfg.oneSideHoldAboveSum,
      oneSideHoldPermanent: cfg.oneSideHoldPermanent,
      profitLockEnabled: cfg.profitLockEnabled,
      profitMaxSum: cfg.profitMaxSum,
      lockSumLimit: lockSumLimit(cfg),
      targetShares: cfg.shares,
      gapInvertSignal: cfg.gapInvertSignal,
      startOnlyNewSlot: cfg.startOnlyNewSlot,
      entryMaxOpenedSecs: cfg.entryMaxOpenedSecs,
      entryMinRemainingSecs: cfg.entryMinRemainingSecs,
      gapSignalEnabled: cfg.gapSignalEnabled,
      pureArbEnabled: cfg.pureArbEnabled,
      trades,
      capitalUsed: Number(capitalUsed.toFixed(4)),
      mode,
      gapSignal: gapSignal ? vnSide(gapSignal) : "FLAT",
      firstLegSide: firstLeg ? vnSide(firstLeg.side) : null,
      firstLegPrice: firstLeg?.entryPrice ?? null,
      firstLegShares: firstLeg?.filledShares ?? null,
      firstLegAgeMs: firstLeg ? Date.now() - firstLeg.placedAtMs : null,
      hedgeSide: hedgeSide ? vnSide(hedgeSide) : null,
      hedgeMaxPrice,
      lastAction: detail,
      riskNote: cfg.oneSideHoldEnabled
        ? `V13 HOLD 1 SIDE bật: nếu SUM > ${cfg.oneSideHoldAboveSum.toFixed(2)} thì không hedge/rescue, giữ phe đang có.`
        : "Bản hybrid chỉ khóa lời khi first-leg + hedge-leg cùng size và tổng giá < 1.00. Nếu chưa hedge được thì vẫn còn rủi ro 1 phe.",
    },
  });
}

async function placeExitSell(ctx: StrategyContext, side: Side, shares: number, reason: string): Promise<void> {
  const bid = ctx.orderBook.bestBidInfo(side);
  const price = bid?.price ?? 0.01;
  const tokenId = sideToken(ctx, side);
  ctx.log(`[${ctx.slug}] gap-arb: RESCUE SELL ${prettySide(side)} ${shares.toFixed(4)} @ ${price} | ${reason}`, "yellow");
  ctx.postOrders([
    {
      req: { tokenId, action: "sell", price, shares, orderType: "GTC" },
      expireAtMs: ctx.slotEndMs,
      onFilled(filledShares) {
        ctx.log(`[${ctx.slug}] gap-arb: rescue SELL ${prettySide(side)} filled ${filledShares.toFixed(4)} @ ${price}`, "green");
      },
      onExpired() {
        ctx.log(`[${ctx.slug}] gap-arb: rescue SELL ${prettySide(side)} expired — emergency sell`, "red");
        const sellIds = ctx.pendingOrders
          .filter((o) => o.action === "sell" && o.tokenId === tokenId)
          .map((o) => o.orderId);
        if (sellIds.length > 0) void ctx.emergencySells(sellIds);
      },
      onFailed(failReason) {
        ctx.log(`[${ctx.slug}] gap-arb: rescue SELL ${prettySide(side)} failed (${failReason})`, "red");
      },
    },
  ]);
}

function placePurePair(params: {
  ctx: StrategyContext;
  cfg: HybridConfig;
  id: number;
  upPrice: number;
  downPrice: number;
  shares: number;
  onDone: (pair: PairLeg, capital: number, locked: boolean) => void;
}): PairLeg {
  const { ctx, cfg, id, upPrice, downPrice, shares, onDone } = params;
  const pair: PairLeg = {
    id,
    startedAt: Date.now(),
    upFilled: 0,
    downFilled: 0,
    upCost: 0,
    downCost: 0,
    status: "placing",
  };
  const expireAtMs = cfg.orderType === "FOK" ? Date.now() + cfg.fillTimeoutMs : ctx.slotEndMs;
  let callbacks = 0;
  const finish = () => {
    callbacks++;
    if (callbacks < 2) return;
    const paired = Math.min(pair.upFilled, pair.downFilled);
    const capital = pair.upCost + pair.downCost;
    if (paired > 0 && Math.abs(pair.upFilled - pair.downFilled) < 0.0001) {
      pair.status = "locked";
      onDone(pair, capital, true);
      return;
    }
    pair.status = "rescue";
    onDone(pair, capital, false);
  };

  const orders: OrderRequest[] = [
    {
      req: { tokenId: ctx.clobTokenIds[0], action: "buy", price: upPrice, shares, orderType: cfg.orderType },
      expireAtMs,
      onFilled(filledShares) {
        pair.upFilled += filledShares;
        pair.upCost += upPrice * filledShares;
        ctx.log(`[${ctx.slug}] gap-arb: PURE BUY/UP filled @ ${upPrice} (${filledShares} shares)`, "green");
        finish();
      },
      onExpired() {
        ctx.log(`[${ctx.slug}] gap-arb: PURE BUY/UP expired`, "yellow");
        finish();
      },
      onFailed(reason) {
        ctx.log(`[${ctx.slug}] gap-arb: PURE BUY/UP failed (${reason})`, "red");
        finish();
      },
    },
    {
      req: { tokenId: ctx.clobTokenIds[1], action: "buy", price: downPrice, shares, orderType: cfg.orderType },
      expireAtMs,
      onFilled(filledShares) {
        pair.downFilled += filledShares;
        pair.downCost += downPrice * filledShares;
        ctx.log(`[${ctx.slug}] gap-arb: PURE SELL/DOWN filled @ ${downPrice} (${filledShares} shares)`, "green");
        finish();
      },
      onExpired() {
        ctx.log(`[${ctx.slug}] gap-arb: PURE SELL/DOWN expired`, "yellow");
        finish();
      },
      onFailed(reason) {
        ctx.log(`[${ctx.slug}] gap-arb: PURE SELL/DOWN failed (${reason})`, "red");
        finish();
      },
    },
  ];

  ctx.postOrders(orders);
  return pair;
}

export const gapSixLayerArb: Strategy = async (ctx) => {
  const cfg = readConfig();

  if (Env.get("PROD") && !cfg.allowProd) {
    ctx.log(
      "[gap-six-layer-arb] Production đang khóa. Test SIM trước; muốn chạy tiền thật set ALLOW_GAP_SIX_LAYER_ARB_PROD=true và DASHBOARD_ALLOW_PROD_START=true.",
      "red",
    );
    process.exit(1);
  }

  const releaseLock = ctx.hold();
  let released = false;
  let firstLeg: FirstLeg | null = null;
  let activePair: PairLeg | null = null;
  let legId = 0;
  let cycles = 0;
  let lastTradeAt = 0;
  let totalCapitalUsed = 0;
  let lastLogAt = 0;
  const strategyStartedAtMs = Date.now();
  const startedOpenedForSecs = Math.max(0, Math.floor((strategyStartedAtMs - ctx.slotStartMs) / 1000));
  const skipStartedSlot = cfg.startOnlyNewSlot
    && strategyStartedAtMs >= ctx.slotStartMs
    && startedOpenedForSecs > cfg.startGraceSecs;

  const release = () => {
    if (!released) {
      released = true;
      releaseLock();
    }
  };

  pushStatus({
    ctx,
    cfg,
    detail: skipStartedSlot
      ? `V9 an toàn deploy: slot này đã mở ${startedOpenedForSecs}s > ${cfg.startGraceSecs}s, sẽ bỏ qua để chờ phiên mới`
      : "Hybrid GAP + 6-Layer đã sẵn sàng",
    trades: cycles,
    capitalUsed: totalCapitalUsed,
  });

  const timer = setInterval(() => {
    const now = Date.now();
    const remaining = Math.floor((ctx.slotEndMs - now) / 1000);
    const openedFor = Math.max(0, Math.floor((now - ctx.slotStartMs) / 1000));
    const marketOpen = now >= ctx.slotStartMs;

    if (remaining <= 0) {
      clearInterval(timer);
      release();
      return;
    }

    if (!marketOpen) {
      pushStatus({
        ctx,
        cfg,
        detail: `Market chưa mở, còn ${Math.max(0, Math.floor((ctx.slotStartMs - now) / 1000))}s`,
        trades: cycles,
        capitalUsed: totalCapitalUsed,
      });
      return;
    }

    // V9 safety: sau khi Railway redeploy, nếu bot được start giữa phiên hiện tại
    // thì bỏ qua slot đó, không nhảy vào lệnh lúc còn 60s/90s.
    if (skipStartedSlot && !firstLeg && !activePair) {
      const msg = `Bỏ qua phiên đang chạy dở sau deploy: slot đã mở ${startedOpenedForSecs}s, còn ${remaining}s. Chờ phiên mới.`;
      ctx.log(`[${ctx.slug}] gap-arb: ${msg}`, "yellow");
      ctx.setDiagnostics({
        pipeline: pipeline({
          scan: { state: "warn", detail: "V9 startup guard" },
          detect: { state: "idle", detail: "Không dùng phiên đang chạy dở" },
          validate: { state: "idle", detail: `opened=${startedOpenedForSecs}s > grace=${cfg.startGraceSecs}s` },
          size: { state: "idle", detail: "Không mở lệnh mới" },
          fill: { state: "idle", detail: "Bỏ qua slot này" },
          hedge: { state: "idle", detail: "Chờ market sau" },
        }),
        arb: {
          mode: "IDLE",
          startupSkipped: true,
          openedForSecs: startedOpenedForSecs,
          remainingSecs: remaining,
          lastAction: msg,
          waitReason: msg,
        } as any,
      });
      clearInterval(timer);
      release();
      return;
    }

    const priceToBeat = ctx.getMarketResult()?.openPrice ?? null;
    const assetPrice = ctx.ticker.price ?? null;
    const gap = priceToBeat !== null && assetPrice !== null ? Number((assetPrice - priceToBeat).toFixed(2)) : null;
    const gapSide = signalFromGap(gap);
    const upAsk = ctx.orderBook.bestAskInfo("UP");
    const downAsk = ctx.orderBook.bestAskInfo("DOWN");
    const upBid = ctx.orderBook.bestBidInfo("UP");
    const downBid = ctx.orderBook.bestBidInfo("DOWN");
    const pureSum = upAsk && downAsk ? Number((upAsk.price + downAsk.price).toFixed(4)) : null;
    const pureEdge = pureSum !== null ? Number(((1 - pureSum) * 100).toFixed(2)) : null;

    // 06 - Hedge existing first-leg. This is the core of your scenario:
    // GAP SIDE = SELL -> first BUY @ 0.46 -> wait SELL <= 0.53 so BUY+SELL <= 0.99.
    // FIX: khi giá hedge đã đạt mục tiêu thì bắn lệnh ngay, không bắt buộc đủ depth cho toàn bộ shares.
    // Nếu depth mỏng thì hedge từng phần để không bỏ lỡ giá đẹp như BUY rơi 0.24.
    if (firstLeg && firstLeg.status === "filled" && firstLeg.filledShares > firstLeg.hedgeShares) {
      const avgFirst = firstLeg.cost / firstLeg.filledShares;
      const hedgeSide = opposite(firstLeg.side);
      const hedgeAsk = ctx.orderBook.bestAskInfo(hedgeSide);
      const maxLock = lockTarget(avgFirst, cfg);
      const maxRescue = rescueTarget(avgFirst, cfg);
      const age = now - firstLeg.filledAtMs!;
      const needShares = Number((firstLeg.filledShares - firstLeg.hedgeShares).toFixed(4));
      const hedgeDepth = hedgeAsk ? sharesAtBest(hedgeAsk.price, hedgeAsk.liquidity) : 0;
      const canLockByPrice = !!hedgeAsk && hedgeAsk.price <= maxLock;
      const mustRescue = age >= cfg.maxHoldFirstLegMs || remaining <= cfg.rescueBeforeCloseSecs;
      const canRescueByPrice = !!hedgeAsk && mustRescue && hedgeAsk.price <= maxRescue;

      if (hedgeAsk) {
        firstLeg.lowestHedgeAsk = firstLeg.lowestHedgeAsk === null
          ? hedgeAsk.price
          : Math.min(firstLeg.lowestHedgeAsk, hedgeAsk.price);
        firstLeg.lastHedgeAsk = hedgeAsk.price;
        if (canLockByPrice && firstLeg.firstLockSeenAtMs === null) firstLeg.firstLockSeenAtMs = now;
      }

      const lowest = firstLeg.lowestHedgeAsk;
      const reboundCents = hedgeAsk && lowest !== null
        ? Number(((hedgeAsk.price - lowest) * 100).toFixed(2))
        : 0;
      const currentSum = hedgeAsk ? Number((avgFirst + hedgeAsk.price).toFixed(4)) : null;
      const currentEdge = currentSum !== null ? Number(((1 - currentSum) * 100).toFixed(2)) : null;
      const oneSideHoldNow = cfg.oneSideHoldEnabled
        && currentSum !== null
        && currentSum > cfg.oneSideHoldAboveSum;
      if (oneSideHoldNow && !firstLeg.holdOneSideActivated) {
        firstLeg.holdOneSideActivated = true;
        firstLeg.holdOneSideAtMs = now;
        firstLeg.holdOneSideReason = `SUM ${currentSum.toFixed(4)} > ${cfg.oneSideHoldAboveSum.toFixed(2)} — HOLD 1 SIDE, không hedge giá xấu`;
        ctx.log(
          `[${ctx.slug}] gap-arb: V13 HOLD 1 SIDE ON | first=${prettySide(firstLeg.side)} avg=${avgFirst.toFixed(2)} hedgeAsk=${hedgeAsk?.price.toFixed(2) ?? "--"} SUM=${currentSum.toFixed(4)} > ${cfg.oneSideHoldAboveSum.toFixed(2)} | không vào hedge nữa`,
          "yellow",
        );
      }
      const holdOneSideActive = firstLeg.holdOneSideActivated && cfg.oneSideHoldPermanent
        ? true
        : oneSideHoldNow;
      const lockSeenAgeMs = firstLeg.firstLockSeenAtMs !== null ? now - firstLeg.firstLockSeenAtMs : 0;
      const deepEnough = !!hedgeAsk && hedgeAsk.price <= cfg.smartHedgeEntryMaxPrice;
      const instantBargain = !!hedgeAsk && hedgeAsk.price <= cfg.smartHedgeInstantPrice;
      const edgeEnoughToTake = canLockByPrice && currentEdge !== null && currentEdge >= cfg.smartHedgeTakeEdgeCents;
      const reversalUp = !!hedgeAsk
        && lowest !== null
        && hedgeAsk.price > lowest
        && reboundCents >= cfg.smartHedgeReboundCents;
      const decisionTimeout = canLockByPrice
        && firstLeg.firstLockSeenAtMs !== null
        && lockSeenAgeMs >= cfg.smartHedgeDecisionMs;
      const waitedTooLongAfterLock = canLockByPrice
        && firstLeg.firstLockSeenAtMs !== null
        && lockSeenAgeMs >= cfg.smartHedgeMaxWaitMs;

      let smartLockOk = canLockByPrice;
      let smartTrigger = canLockByPrice ? "LOCK_PRICE" : "WAIT";
      if (cfg.smartHedgeEnabled && canLockByPrice && !mustRescue) {
        // V5 FIX: không đợi đáy quá lâu. Nếu edge đã đủ dày, hoặc giá đã đạt target
        // một khoảng thời gian ngắn, bot phải khóa luôn để tránh bị đảo ngược và lỗ.
        smartLockOk = instantBargain || edgeEnoughToTake || (deepEnough && reversalUp) || decisionTimeout || waitedTooLongAfterLock;
        smartTrigger = instantBargain
          ? `GIÁ SIÊU RẺ <= ${cfg.smartHedgeInstantPrice.toFixed(2)}`
          : edgeEnoughToTake
            ? `EDGE ĐỦ DÀY ${currentEdge?.toFixed(2)}¢ >= ${cfg.smartHedgeTakeEdgeCents.toFixed(2)}¢`
            : deepEnough && reversalUp
              ? `BẮT ĐẢO CHIỀU +${reboundCents.toFixed(2)}¢ từ đáy ${lowest?.toFixed(2)}`
              : decisionTimeout
                ? `ĐẠT TARGET ${Math.round(lockSeenAgeMs / 1000)}s, KHÓA LỜI`
                : waitedTooLongAfterLock
                  ? "CHỜ QUÁ LÂU, KHÓA LỜI"
                  : `ĐỢI SÂU/ĐẢO CHIỀU: đáy=${lowest?.toFixed(2) ?? "--"}, hồi=${reboundCents.toFixed(2)}¢, edge=${currentEdge?.toFixed(2) ?? "--"}¢`;
      }

      // V5: có 4 cách bắn hedge:
      // 1) Giá siêu rẻ, 2) Edge đủ dày, 3) Rơi sâu rồi hồi, 4) Đạt target quá N giây.
      const lockQty = holdOneSideActive ? 0 : (smartLockOk ? hedgeQty(needShares, hedgeDepth, cfg, true) : 0);
      const rescueQty = holdOneSideActive ? 0 : (canRescueByPrice ? hedgeQty(needShares, hedgeDepth, cfg, true) : 0);

      const placeHedgeBuy = (kind: "LOCK" | "RESCUE", qty: number, maxAllowedPrice: number) => {
        if (!firstLeg || !hedgeAsk || qty <= 0) return false;
        const activeId = firstLeg.id;
        const orderPrice = limitBuyPrice(hedgeAsk.price, maxAllowedPrice, cfg);
        firstLeg.status = "placing";
        ctx.log(
          `[${ctx.slug}] gap-arb: ${kind} TRIGGER ${smartTrigger} | first=${prettySide(firstLeg.side)} ${avgFirst.toFixed(2)} + hedge=${prettySide(hedgeSide)} ask=${hedgeAsk.price.toFixed(2)} order=${orderPrice.toFixed(2)} qty=${qty}/${needShares} SUM≈${(avgFirst + orderPrice).toFixed(2)}`,
          kind === "LOCK" ? "cyan" : "yellow",
        );
        ctx.postOrders([
          {
            req: { tokenId: sideToken(ctx, hedgeSide), action: "buy", price: orderPrice, shares: qty, orderType: cfg.hedgeOrderType },
            expireAtMs: now + cfg.hedgeFillTimeoutMs,
            onFilled(filledShares) {
              if (!firstLeg || firstLeg.id !== activeId) return;
              firstLeg.hedgeShares += filledShares;
              firstLeg.hedgeCost += orderPrice * filledShares;
              totalCapitalUsed += orderPrice * filledShares;
              const left = Number((firstLeg.filledShares - firstLeg.hedgeShares).toFixed(4));
              const avgHedge = firstLeg.hedgeCost / Math.max(0.000001, firstLeg.hedgeShares);
              const lockSum = (firstLeg.cost / firstLeg.filledShares) + avgHedge;
              const edgeCents = (1 - lockSum) * 100;

              if (left <= 0.0001) {
                firstLeg.status = "locked";
                ctx.log(
                  `[${ctx.slug}] gap-arb: LOCKED đủ 2 phe ${prettySide(firstLeg.side)} + ${prettySide(hedgeSide)} | SUM=${lockSum.toFixed(4)} edge=${edgeCents.toFixed(2)}¢ shares=${firstLeg.hedgeShares.toFixed(4)}`,
                  "green",
                );
                ctx.setDiagnostics({
                  pipeline: pipeline({
                    scan: { state: "pass", detail: "Market đã xử lý" },
                    detect: { state: "pass", detail: "GAP signal đã dùng" },
                    validate: { state: edgeCents >= 0 ? "pass" : "warn", detail: `Tổng giá ${lockSum.toFixed(4)}` },
                    size: { state: "pass", detail: `${firstLeg.hedgeShares.toFixed(2)} shares locked` },
                    fill: { state: "pass", detail: "Đã fill đủ 2 phe" },
                    hedge: { state: edgeCents >= 0 ? "pass" : "warn", detail: `SUM=${lockSum.toFixed(4)}, edge=${edgeCents.toFixed(2)}¢` },
                  }),
                  arb: {
                    mode: edgeCents >= 0 ? "LOCKED" : "RESCUE",
                    hedgeAsk: orderPrice,
                    lockSum: Number(lockSum.toFixed(4)),
                    lockedEdgeCents: Number(edgeCents.toFixed(2)),
                    profitIfLocked: Number(((edgeCents / 100) * firstLeg.hedgeShares).toFixed(4)),
                    profitSumLimit: lockSumLimit(cfg),
                    capitalUsed: Number(totalCapitalUsed.toFixed(4)),
                    fillLatencyMs: Date.now() - firstLeg.placedAtMs,
                    lastAction: edgeCents >= 0 ? "Đã khóa đủ 2 phe dưới 1.00" : "Rescue đã đủ 2 phe nhưng khóa lỗ nhỏ",
                    riskNote: "Đã có BUY + SELL cùng size. Vẫn cần theo dõi settlement/rule của market.",
                  },
                });
                firstLeg = null;
              } else {
                firstLeg.status = "filled";
                ctx.log(
                  `[${ctx.slug}] gap-arb: PARTIAL HEDGE ${prettySide(hedgeSide)} filled ${filledShares.toFixed(4)} | còn cần ${left.toFixed(4)} shares`,
                  "yellow",
                );
                ctx.setDiagnostics({
                  arb: {
                    mode: kind === "LOCK" ? "WAIT_HEDGE" : "RESCUE",
                    hedgeAsk: orderPrice,
                    lockSum: Number(lockSum.toFixed(4)),
                    lockedEdgeCents: Number(edgeCents.toFixed(2)),
                    capitalUsed: Number(totalCapitalUsed.toFixed(4)),
                    lastAction: `Partial hedge: còn ${left.toFixed(2)} shares cần khóa`,
                  },
                });
              }
            },
            onExpired() {
              if (!firstLeg || firstLeg.id !== activeId) return;
              firstLeg.status = "filled";
              ctx.log(`[${ctx.slug}] gap-arb: ${kind} hedge ${prettySide(hedgeSide)} expired — tiếp tục canh`, "yellow");
            },
            onFailed(reason) {
              if (!firstLeg || firstLeg.id !== activeId) return;
              firstLeg.status = "filled";
              ctx.log(`[${ctx.slug}] gap-arb: ${kind} hedge ${prettySide(hedgeSide)} failed (${reason})`, "red");
            },
          },
        ]);
        return true;
      };

      ctx.setDiagnostics({
        pipeline: pipeline({
          scan: { state: "pass", detail: "Đang giữ first-leg" },
          detect: { state: "pass", detail: `GAP SIDE ${gapSide ? vnSide(gapSide) : "FLAT"} → đã mua ${prettySide(firstLeg.side)}` },
          validate: {
            state: holdOneSideActive ? "warn" : lockQty > 0 ? "pass" : canLockByPrice ? "warn" : "watch",
            detail: holdOneSideActive
              ? `HOLD 1 SIDE: SUM=${currentSum?.toFixed(4) ?? "--"} > ${cfg.oneSideHoldAboveSum.toFixed(2)}, không hedge`
              : `${prettySide(hedgeSide)} ask ${fmtPrice(hedgeAsk?.price)} cần <= ${maxLock.toFixed(2)} | đáy=${lowest?.toFixed(2) ?? "--"} | ${smartTrigger}`,
          },
          size: {
            state: holdOneSideActive ? "warn" : lockQty > 0 || rescueQty > 0 ? "pass" : "watch",
            detail: holdOneSideActive
              ? `Giữ 1 phe ${needShares.toFixed(2)} shares; không mua hedge`
              : `Cần hedge ${needShares.toFixed(2)}, có thể bắn ${Math.max(lockQty, rescueQty).toFixed(2)}`,
          },
          fill: { state: "pass", detail: `First ${prettySide(firstLeg.side)} @ ${avgFirst.toFixed(2)}` },
          hedge: {
            state: holdOneSideActive ? "warn" : lockQty > 0 ? "pass" : rescueQty > 0 ? "warn" : "watch",
            detail: holdOneSideActive
              ? `HOLD 1 SIDE — SUM > ${cfg.oneSideHoldAboveSum.toFixed(2)}, chặn hedge/rescue`
              : lockQty > 0
                ? `Bắn hedge: ${smartTrigger}`
                : rescueQty > 0
                  ? `Rescue SUM <= ${cfg.maxRescueSum.toFixed(2)}`
                  : canLockByPrice
                    ? `Giá đã đạt nhưng smart đang ${smartTrigger}`
                    : `Đợi hedge <= ${maxLock.toFixed(2)} hoặc rescue <= ${maxRescue.toFixed(2)}`,
          },
        }),
        arb: {
          mode: holdOneSideActive ? "HOLD_ONE_SIDE" : mustRescue ? "RESCUE" : "WAIT_HEDGE",
          gapSignal: gapSide ? vnSide(gapSide) : "FLAT",
          firstLegSide: vnSide(firstLeg.side),
          firstLegPrice: Number(avgFirst.toFixed(4)),
          firstLegShares: firstLeg.filledShares,
          firstLegAgeMs: age,
          hedgeSide: vnSide(hedgeSide),
          hedgeMaxPrice: maxLock,
          hedgeAsk: hedgeAsk?.price ?? null,
          lockSum: currentSum,
          lockedEdgeCents: currentEdge,
          profitIfLocked: currentEdge !== null ? Number(((currentEdge / 100) * needShares).toFixed(4)) : null,
          profitSumLimit: lockSumLimit(cfg),
          trades: cycles,
          capitalUsed: Number(totalCapitalUsed.toFixed(4)),
          lastAction: holdOneSideActive
            ? (firstLeg.holdOneSideReason ?? `HOLD 1 SIDE vì SUM > ${cfg.oneSideHoldAboveSum.toFixed(2)}`)
            : lockQty > 0
              ? `Bắn hedge: ${smartTrigger} | mua ${prettySide(hedgeSide)} qty=${lockQty}`
              : rescueQty > 0
                ? `Rescue: mua ${prettySide(hedgeSide)} qty=${rescueQty}`
                : canLockByPrice
                  ? `Giá đạt nhưng đang đợi sâu/đảo chiều: ${smartTrigger}`
                  : `Đang chờ ${prettySide(hedgeSide)} <= ${maxLock.toFixed(2)}`,
          lastTrigger: `First ${prettySide(firstLeg.side)} @ ${avgFirst.toFixed(2)}, min edge ${cfg.minLockEdgeCents}¢, rescue max SUM ${cfg.maxRescueSum.toFixed(2)}`,
          riskNote: holdOneSideActive
            ? "V13 đang HOLD 1 SIDE: bot không hedge/rescue khi SUM > ngưỡng 1.03 để tránh mua hedge giá xấu. Rủi ro: nếu phe đang giữ thua settlement thì mất vốn first-leg."
            : "Đang giữ 1 phe: chưa phải arbitrage. Smart hedge sẽ đợi giá phe còn lại rơi sâu, rồi bắn khi giá siêu rẻ hoặc có dấu hiệu hồi từ đáy; gần hết giờ vẫn rescue theo MAX_RESCUE_SUM.",
          oneSideHoldEnabled: cfg.oneSideHoldEnabled,
          oneSideHoldAboveSum: cfg.oneSideHoldAboveSum,
          oneSideHoldActive: holdOneSideActive,
          oneSideHoldPermanent: cfg.oneSideHoldPermanent,
          oneSideHoldReason: firstLeg.holdOneSideReason,
          lowestHedgeAsk: lowest,
          hedgeReboundCents: reboundCents,
          smartHedgeTrigger: smartTrigger,
          smartHedgeLockSeenAgeMs: lockSeenAgeMs,
          smartHedgeTakeEdgeCents: cfg.smartHedgeTakeEdgeCents,
          smartHedgeDecisionMs: cfg.smartHedgeDecisionMs,
        },
      });

      if (holdOneSideActive) {
        // V13: SUM > 1.03 thì không vào hedge/rescue nữa, giữ 1 bên.
        return;
      }

      if (lockQty > 0) {
        placeHedgeBuy("LOCK", lockQty, maxLock);
        return;
      }

      if (mustRescue && rescueQty > 0) {
        placeHedgeBuy("RESCUE", rescueQty, maxRescue);
        return;
      }

      if (mustRescue && needShares > 0 && !holdOneSideActive) {
        const reason = age >= cfg.maxHoldFirstLegMs
          ? `quá thời gian giữ first-leg ${Math.round(age / 1000)}s`
          : `market sắp đóng, còn ${remaining}s`;
        firstLeg.status = "rescue";
        firstLeg.reason = reason;
        ctx.setDiagnostics({
          pipeline: pipeline({
            scan: { state: "pass", detail: "Đã có first-leg" },
            detect: { state: "warn", detail: "Không đạt giá rescue hedge" },
            validate: { state: "warn", detail: `SUM hiện tại ${currentSum?.toFixed(4) ?? "--"} > rescue ${cfg.maxRescueSum.toFixed(2)}` },
            size: { state: "pass", detail: `${needShares.toFixed(2)} shares cần thoát` },
            fill: { state: "warn", detail: "Bán thoát first-leg" },
            hedge: { state: "warn", detail: "Không hedge bừa vì sẽ khóa lỗ sâu" },
          }),
          arb: {
            mode: "RESCUE",
            rescueReason: reason,
            lastAction: `Rescue SELL ${prettySide(firstLeg.side)} vì hedge quá đắt`,
          },
        });
        void placeExitSell(ctx, firstLeg.side, needShares, reason);
        firstLeg = null;
        return;
      }
      return;
    }

    if (firstLeg?.status === "placing" || activePair?.status === "placing") {
      pushStatus({
        ctx,
        cfg,
        mode: firstLeg ? "GAP_FIRST_LEG" : "PURE_ARB",
        detail: "Đang chờ fill lệnh vừa gửi",
        gapSignal: gapSide,
        firstLeg,
        trades: cycles,
        capitalUsed: totalCapitalUsed,
        pureSum,
        pureEdgeCents: pureEdge,
      });
      return;
    }

    if (cycles >= cfg.maxCyclesPerMarket) {
      ctx.setDiagnostics({
        pipeline: pipeline({
          scan: { state: "pass", detail: "Đủ số cycle cho market này" },
          detect: { state: "idle", detail: "Không mở thêm" },
          validate: { state: "idle", detail: `${cycles}/${cfg.maxCyclesPerMarket}` },
          size: { state: "idle", detail: "Đã khóa entry mới" },
          fill: { state: "idle", detail: "Không gửi lệnh" },
          hedge: { state: "idle", detail: "Chờ market sau" },
        }),
        arb: { mode: "IDLE", trades: cycles, capitalUsed: Number(totalCapitalUsed.toFixed(4)), lastAction: "Đủ cycle, chờ market tiếp theo" },
      });
      clearInterval(timer);
      release();
      return;
    }

    const tooLateByRemaining = remaining < cfg.entryMinRemainingSecs;
    const tooLateByOpened = openedFor > cfg.entryMaxOpenedSecs;
    if (tooLateByRemaining || tooLateByOpened || remaining < cfg.minRemainingSecs) {
      const reason = tooLateByOpened
        ? `Quá trễ để vào mới: market đã mở ${openedFor}s > ENTRY_MAX_OPENED_SECS=${cfg.entryMaxOpenedSecs}s`
        : tooLateByRemaining
          ? `Không đủ thời gian: còn ${remaining}s < ENTRY_MIN_REMAINING_SECS=${cfg.entryMinRemainingSecs}s`
          : `Còn ${remaining}s, ngừng vào mới`;
      ctx.setDiagnostics({
        pipeline: pipeline({
          scan: { state: "warn", detail: reason },
          detect: { state: "idle", detail: "Chờ market sau" },
          validate: { state: "idle", detail: "V9 chặn entry muộn sau deploy" },
          size: { state: "idle", detail: "Không mở size mới" },
          fill: { state: "idle", detail: "Không gửi lệnh" },
          hedge: { state: "idle", detail: "Không có lệnh active" },
        }),
        arb: {
          mode: "IDLE",
          trades: cycles,
          openedForSecs: openedFor,
          remainingSecs: remaining,
          entryMaxOpenedSecs: cfg.entryMaxOpenedSecs,
          entryMinRemainingSecs: cfg.entryMinRemainingSecs,
          lastAction: reason,
          waitReason: reason,
        } as any,
      });
      if (now - lastLogAt > 3000) {
        lastLogAt = now;
        ctx.log(`[${ctx.slug}] gap-arb: ${reason}`, "dim");
      }
      clearInterval(timer);
      release();
      return;
    }

    if (now - lastTradeAt < cfg.cooldownMs) {
      pushStatus({ ctx, cfg, detail: "Cooldown sau cycle trước", gapSignal: gapSide, trades: cycles, capitalUsed: totalCapitalUsed, pureSum, pureEdgeCents: pureEdge });
      return;
    }

    if (!upAsk || !downAsk) {
      pushStatus({ ctx, cfg, detail: "Đang chờ đủ orderbook BUY/SELL", gapSignal: gapSide, trades: cycles, capitalUsed: totalCapitalUsed });
      return;
    }

    const upDepth = sharesAtBest(upAsk.price, upAsk.liquidity);
    const downDepth = sharesAtBest(downAsk.price, downAsk.liquidity);
    const depthShares = Math.floor(Math.min(upDepth, downDepth));
    const pureDepthOk = cfg.orderType === "GTC" && cfg.ignoreDepthForGtc ? true : depthShares >= cfg.minDepthShares;
    const entrySumLimit = lockSumLimit(cfg);
    const pureValid = cfg.pureArbEnabled && pureSum !== null && pureEdge !== null && pureSum <= entrySumLimit && pureEdge >= cfg.minLockEdgeCents && pureDepthOk;

    // Mode 1: pure arb, safest. If the book already breaks, buy both sides immediately.
    if (pureValid) {
      const size = cfg.orderType === "GTC" && cfg.ignoreDepthForGtc ? cfg.shares : Math.min(cfg.shares, depthShares);
      const thisId = ++legId;
      cycles++;
      lastTradeAt = now;
      ctx.log(`[${ctx.slug}] gap-arb: PURE ARB detected BUY+SELL=${pureSum!.toFixed(4)} edge=${pureEdge!.toFixed(2)}¢ size=${size}`, "cyan");
      ctx.setDiagnostics({
        pipeline: pipeline({
          scan: { state: "pass", detail: "Orderbook live" },
          detect: { state: "pass", detail: `Pure arb SUM=${pureSum!.toFixed(4)} <= ${entrySumLimit.toFixed(4)}` },
          validate: { state: "pass", detail: `Edge ${pureEdge!.toFixed(2)}¢ đạt chuẩn` },
          size: { state: "pass", detail: `${size} paired shares` },
          fill: { state: "watch", detail: "Gửi BUY + SELL cùng lúc" },
          hedge: { state: "idle", detail: "Chỉ rescue nếu lệch fill" },
        }),
        arb: {
          mode: "PURE_ARB",
          executable: true,
          targetShares: size,
          trades: cycles,
          capitalNeeded: Number((pureSum! * size).toFixed(4)),
          lastAction: "Pure arb: gửi 2 phe ngay",
          lastTrigger: `BUY ${upAsk.price.toFixed(2)} + SELL ${downAsk.price.toFixed(2)} = ${pureSum!.toFixed(4)} | limit ${entrySumLimit.toFixed(4)}`,
        },
      });
      activePair = placePurePair({
        ctx,
        cfg,
        id: thisId,
        upPrice: upAsk.price,
        downPrice: downAsk.price,
        shares: size,
        onDone(pair, capital, locked) {
          if (!activePair || activePair.id !== pair.id) return;
          totalCapitalUsed += capital;
          const paired = Math.min(pair.upFilled, pair.downFilled);
          if (locked) {
            const avgUp = pair.upCost / pair.upFilled;
            const avgDown = pair.downCost / pair.downFilled;
            const sum = avgUp + avgDown;
            const edgeCents = (1 - sum) * 100;
            ctx.log(`[${ctx.slug}] gap-arb: PURE LOCKED SUM=${sum.toFixed(4)} edge=${edgeCents.toFixed(2)}¢ shares=${paired}`, "green");
            ctx.setDiagnostics({
              pipeline: pipeline({
                scan: { state: "pass", detail: "Pure arb hoàn tất" },
                detect: { state: "pass", detail: "SUM < 1.00" },
                validate: { state: "pass", detail: "Đã fill đủ 2 phe" },
                size: { state: "pass", detail: `${paired} shares` },
                fill: { state: "pass", detail: "BUY + SELL filled" },
                hedge: { state: "pass", detail: `Edge ${edgeCents.toFixed(2)}¢` },
              }),
              arb: {
                mode: "LOCKED",
                lockSum: Number(sum.toFixed(4)),
                lockedEdgeCents: Number(edgeCents.toFixed(2)),
                profitIfLocked: Number(((edgeCents / 100) * paired).toFixed(4)),
                profitSumLimit: lockSumLimit(cfg),
                capitalUsed: Number(totalCapitalUsed.toFixed(4)),
                fillLatencyMs: Date.now() - pair.startedAt,
                lastAction: "Pure arb locked",
              },
            });
          } else {
            const upExtra = Math.max(0, pair.upFilled - pair.downFilled);
            const downExtra = Math.max(0, pair.downFilled - pair.upFilled);
            ctx.log(`[${ctx.slug}] gap-arb: PURE fill lệch, rescue upExtra=${upExtra} downExtra=${downExtra}`, "yellow");
            if (upExtra > 0) void placeExitSell(ctx, "UP", upExtra, "pure arb fill lệch UP");
            if (downExtra > 0) void placeExitSell(ctx, "DOWN", downExtra, "pure arb fill lệch DOWN");
            ctx.setDiagnostics({ arb: { mode: "RESCUE", capitalUsed: Number(totalCapitalUsed.toFixed(4)), rescueReason: "pure arb fill lệch" } });
          }
          activePair = null;
        },
      });
      return;
    }

    // Mode 2: your idea — use old GAP SIDE, buy the opposite cheap side first, then wait for opposite leg.
    const gapOk = gap !== null && Math.abs(gap) >= cfg.minAbsGap;
    const withinEntryWindow = openedFor <= Math.min(cfg.firstEntryWindowSecs, cfg.entryMaxOpenedSecs);
    const canUseGap = cfg.gapSignalEnabled && gapSide !== null && gapOk && withinEntryWindow;
    if (!canUseGap) {
      const reasons: string[] = [];
      if (!cfg.gapSignalEnabled) reasons.push("GAP_SIGNAL_ENABLED=false nên không dùng GAP entry");
      if (gapSide === null) reasons.push("GAP SIDE đang FLAT/chưa có dữ liệu");
      if (!gapOk) reasons.push(`Gap ${gap ?? "--"} chưa đạt GAP_MIN_ABS_PRICE=${cfg.minAbsGap}`);
      if (!withinEntryWindow) reasons.push(`Quá cửa sổ entry ${openedFor}s > ${cfg.firstEntryWindowSecs}s`);
      if (pureSum !== null && pureSum > lockSumLimit(cfg)) reasons.push(`Pure SUM ${pureSum.toFixed(4)} > chốt ${lockSumLimit(cfg).toFixed(4)}`);
      if (pureSum !== null && pureEdge !== null && pureEdge < cfg.minLockEdgeCents) reasons.push(`Pure edge ${pureEdge.toFixed(2)}¢ < min ${cfg.minLockEdgeCents.toFixed(2)}¢`);
      if (cfg.pureArbEnabled && !pureDepthOk) reasons.push(`Pure depth ${depthShares} < min ${cfg.minDepthShares}`);
      const reasonText = reasons[0] ?? "Chờ GAP SIDE hoặc pure arb";
      if (now - lastLogAt > 2500) {
        lastLogAt = now;
        ctx.log(`[${ctx.slug}] gap-arb: scan gap=${gap ?? "--"} side=${gapSide ? vnSide(gapSide) : "FLAT"} pureSum=${pureSum?.toFixed(4) ?? "--"} | WAIT: ${reasonText}`, "dim");
      }
      pushStatus({ ctx, cfg, detail: reasonText, gapSignal: gapSide, trades: cycles, capitalUsed: totalCapitalUsed, pureSum, pureEdgeCents: pureEdge });
      ctx.setDiagnostics({ arb: { lastAction: reasonText, waitReason: reasonText, waitReasons: reasons.join(" | ") } as any });
      return;
    }

    const firstSide = cfg.gapInvertSignal ? opposite(gapSide) : gapSide;
    const firstAsk = firstSide === "UP" ? upAsk : downAsk;
    const firstDepth = sharesAtBest(firstAsk.price, firstAsk.liquidity);
    const validFirstPrice = firstAsk.price <= cfg.firstLegMaxPrice;
    const validFirstDepth = cfg.firstOrderType === "GTC" && cfg.ignoreDepthForGtc ? true : firstDepth >= cfg.minDepthShares;

    ctx.setDiagnostics({
      pipeline: pipeline({
        scan: { state: "pass", detail: `Market mở ${openedFor}s, còn ${remaining}s` },
        detect: { state: "pass", detail: `GAP SIDE=${vnSide(gapSide)} → mua ${cfg.gapInvertSignal ? "ngược" : "cùng"} ${prettySide(firstSide)}` },
        validate: {
          state: validFirstPrice && validFirstDepth ? "pass" : validFirstPrice ? "warn" : "watch",
          detail: `${prettySide(firstSide)} ask=${firstAsk.price.toFixed(2)} cần <= ${cfg.firstLegMaxPrice.toFixed(2)}, depth=${Math.floor(firstDepth)}`,
        },
        size: { state: validFirstDepth ? "pass" : "warn", detail: `target ${cfg.shares}, depth ${Math.floor(firstDepth)}` },
        fill: { state: "idle", detail: "Chờ first-leg đạt giá" },
        hedge: { state: "idle", detail: "Sau khi fill sẽ canh phe đối diện" },
      }),
      arb: {
        mode: "GAP_FIRST_LEG",
        gapSignal: vnSide(gapSide),
        gapInvertSignal: cfg.gapInvertSignal,
        firstLegSide: vnSide(firstSide),
        firstLegPrice: firstAsk.price,
        hedgeSide: vnSide(gapSide),
        hedgeMaxPrice: lockTarget(firstAsk.price, cfg),
        profitSumLimit: lockSumLimit(cfg),
        lastAction: validFirstPrice && validFirstDepth ? "First-leg đạt chuẩn" : "Chờ first-leg rẻ hơn",
        lastTrigger: `Signal ${vnSide(gapSide)} → mua ${cfg.gapInvertSignal ? "ngược" : "cùng"} ${vnSide(firstSide)}`,
        riskNote: "First-leg là lệnh 1 phe. Chỉ khóa lời khi mua thêm phe đối diện sao cho tổng < 1.00.",
      },
    });

    if (!validFirstPrice || !validFirstDepth) return;

    const size = cfg.firstOrderType === "GTC" && cfg.ignoreDepthForGtc ? cfg.shares : Math.min(cfg.shares, Math.floor(firstDepth));
    const id = ++legId;
    cycles++;
    lastTradeAt = now;
    firstLeg = {
      id,
      side: firstSide,
      signalSide: gapSide,
      entryPrice: firstAsk.price,
      shares: size,
      filledShares: 0,
      cost: 0,
      placedAtMs: now,
      filledAtMs: null,
      hedgeShares: 0,
      hedgeCost: 0,
      status: "placing",
      reason: null,
      lowestHedgeAsk: null,
      lastHedgeAsk: null,
      firstLockSeenAtMs: null,
      holdOneSideActivated: false,
      holdOneSideAtMs: null,
      holdOneSideReason: null,
    };

    ctx.log(
      `[${ctx.slug}] gap-arb: GAP SIDE=${vnSide(gapSide)} => ${cfg.gapInvertSignal ? "INVERT" : "DIRECT"} first-leg ${prettySide(firstSide)} @ ${firstAsk.price.toFixed(2)} | chờ ${prettySide(opposite(firstSide))} <= ${lockTarget(firstAsk.price, cfg).toFixed(2)}`,
      "cyan",
    );

    ctx.postOrders([
      {
        req: {
          tokenId: sideToken(ctx, firstSide),
          action: "buy",
          price: firstAsk.price,
          shares: size,
          orderType: cfg.firstOrderType,
        },
        expireAtMs: now + cfg.fillTimeoutMs,
        onFilled(filledShares) {
          if (!firstLeg || firstLeg.id !== id) return;
          firstLeg.filledShares += filledShares;
          firstLeg.cost += firstAsk.price * filledShares;
          firstLeg.filledAtMs = Date.now();
          firstLeg.status = "filled";
          totalCapitalUsed += firstAsk.price * filledShares;
          ctx.log(
            `[${ctx.slug}] gap-arb: FIRST filled ${prettySide(firstSide)} @ ${firstAsk.price} (${filledShares} shares). Bắt đầu canh ${prettySide(opposite(firstSide))} <= ${lockTarget(firstAsk.price, cfg).toFixed(2)}`,
            "green",
          );
        },
        onExpired() {
          if (!firstLeg || firstLeg.id !== id) return;
          ctx.log(`[${ctx.slug}] gap-arb: FIRST ${prettySide(firstSide)} expired — bỏ cycle`, "yellow");
          firstLeg = null;
        },
        onFailed(reason) {
          if (!firstLeg || firstLeg.id !== id) return;
          ctx.log(`[${ctx.slug}] gap-arb: FIRST ${prettySide(firstSide)} failed (${reason})`, "red");
          firstLeg = null;
        },
      },
    ]);
  }, cfg.scanMs);

  return () => {
    clearInterval(timer);
    release();
  };
};
