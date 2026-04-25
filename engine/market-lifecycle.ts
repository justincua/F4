import { OrderBook } from "../tracker/orderbook.ts";
import { APIQueue } from "../tracker/api-queue.ts";
import { Logger } from "./logger.ts";
import type { ActiveMarketSnapshot, ArbSnapshot, PipelineStageSnapshot } from "./dashboard-state.ts";
import type { EarlyBirdClient, PlacedOrder } from "./client.ts";
import type { LogColor } from "./log.ts";
import type {
  Strategy,
  StrategyContext,
  OrderRequest,
} from "./strategy/types.ts";
import type { CancelOrderResponse, Order } from "../utils/trading.ts";
import type { WalletTracker } from "./wallet-tracker.ts";
import type { TickerTracker } from "../tracker/ticker";
import { slotFromSlug } from "../utils/slot.ts";
import { Env } from "../utils/config.ts";

export type LifecycleState = "INIT" | "RUNNING" | "STOPPING" | "DONE";

export type PendingOrder = {
  orderId: string;
  tokenId: string;
  action: "buy" | "sell";
  orderType?: "GTC" | "FOK";
  price: number;
  shares: number;
  expireAtMs: number;
  placedAtMs: number;
  onFilled?: (filledShares: number) => void;
  onExpired?: () => void | Promise<void>;
  onFailed?: (reason: string) => void | Promise<void>;
};

export type CompletedOrder = {
  action: "buy" | "sell";
  price: number;
  shares: number;
  fee: number;
  tokenId: string;
};

/** Serializable subset of PendingOrder (no callbacks). */
export type PendingOrderSnapshot = Omit<
  PendingOrder,
  "onFilled" | "onExpired" | "onFailed"
>;

type RecoveryOptions = {
  state: "RUNNING" | "STOPPING";
  clobTokenIds: [string, string];
  pendingOrders: PendingOrder[];
  orderHistory: CompletedOrder[];
};

type MarketLifecycleOptions = {
  slug: string;
  apiQueue: APIQueue;
  client: EarlyBirdClient;
  log: (msg: string, color?: LogColor) => void;
  strategyName: string;
  strategy: Strategy;
  tracker: WalletTracker;
  ticker: TickerTracker;
  recovery?: RecoveryOptions;
  alwaysLog?: boolean;
};

const PIPELINE_LABELS: Record<PipelineStageSnapshot["key"], string> = {
  scan: "01 Scan",
  detect: "02 Detect",
  validate: "03 Validate",
  size: "04 Size",
  fill: "05 Fill",
  hedge: "06 Hedge",
};

function makePipeline(
  patch?: Partial<Record<PipelineStageSnapshot["key"], Partial<PipelineStageSnapshot>>>,
): PipelineStageSnapshot[] {
  const now = new Date().toISOString();
  return (["scan", "detect", "validate", "size", "fill", "hedge"] as const).map((key) => ({
    key,
    label: PIPELINE_LABELS[key],
    state: patch?.[key]?.state ?? "idle",
    detail: patch?.[key]?.detail ?? "Chờ dữ liệu",
    updatedAt: patch?.[key]?.updatedAt ?? now,
  }));
}

function readNumEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function makeArbSnapshot(params: {
  upAsk: { price: number; liquidity: number } | null;
  downAsk: { price: number; liquidity: number } | null;
  upBid: { price: number; liquidity: number } | null;
  downBid: { price: number; liquidity: number } | null;
  patch?: Partial<ArbSnapshot>;
}): ArbSnapshot {
  const yesAsk = params.upAsk?.price ?? null;
  const noAsk = params.downAsk?.price ?? null;
  const yesBid = params.upBid?.price ?? null;
  const noBid = params.downBid?.price ?? null;
  const sum = yesAsk !== null && noAsk !== null ? Number((yesAsk + noAsk).toFixed(4)) : null;
  const edge = sum !== null ? Number((1 - sum).toFixed(4)) : null;
  const minEdgeCents = readNumEnv("ARB_MIN_EDGE_CENTS", readNumEnv("MIN_LOCK_EDGE_CENTS", 1));
  const rawMaxEntrySum = readNumEnv("ARB_MAX_ENTRY_SUM", Number((1 - minEdgeCents / 100).toFixed(4)));
  const profitMaxSum = readNumEnv("PROFIT_MAX_SUM", readNumEnv("TAKE_PROFIT_MAX_SUM", rawMaxEntrySum));
  const maxEntrySum = Number(Math.min(rawMaxEntrySum, profitMaxSum).toFixed(4));
  const targetShares = Math.max(1, Math.floor(readNumEnv("TRADE_SHARES", readNumEnv("ORDER_SHARES", readNumEnv("SHARES", 10)))));
  const upDepthShares = params.upAsk && params.upAsk.price > 0 ? params.upAsk.liquidity / params.upAsk.price : null;
  const downDepthShares = params.downAsk && params.downAsk.price > 0 ? params.downAsk.liquidity / params.downAsk.price : null;
  const depthShares = upDepthShares !== null && downDepthShares !== null
    ? Number(Math.min(upDepthShares, downDepthShares).toFixed(2))
    : null;
  const capitalNeeded = sum !== null ? Number((sum * targetShares).toFixed(4)) : null;
  const ignoreDepthForGtc = (process.env.GAP_ORDER_TYPE !== "FOK" && process.env.GAP_IGNORE_DEPTH_FOR_GTC !== "false");
  const executable = sum !== null && sum <= maxEntrySum && (ignoreDepthForGtc || (depthShares ?? 0) >= targetShares);

  return {
    yesAsk,
    noAsk,
    yesBid,
    noBid,
    yesLiquidity: params.upAsk?.liquidity ?? null,
    noLiquidity: params.downAsk?.liquidity ?? null,
    sum,
    edge,
    edgeCents: edge !== null ? Number((edge * 100).toFixed(2)) : null,
    minEdgeCents,
    maxEntrySum,
    executable,
    targetShares,
    depthShares,
    capitalNeeded,
    capitalUsed: 0,
    fillLatencyMs: null,
    trades: 0,
    lastAction: null,
    lastTrigger: null,
    riskNote: "Chỉ gần-neutral khi cả YES và NO đều fill đủ cùng số shares.",
    ...params.patch,
  };
}

export class MarketLifecycle {
  private _state: LifecycleState = "INIT";
  private _ticking = false;
  private _orderBook = new OrderBook();

  private _clobTokenIds: [string, string] | null = null;
  private _conditionId: string | null = null;

  private _feeRate = 0;
  private _pendingOrders: PendingOrder[] = [];
  private _orderHistory: CompletedOrder[] = [];
  private _buyBlocked = false;
  private _sellBlocked = false;
  private _pnl = 0;
  private _inFlight = 0;
  private _strategyLocks = 0;
  private _marketLogger = new Logger();
  private _marketOpenTimer: ReturnType<typeof setTimeout> | null = null;
  private _marketPriceHandle: { cancel: () => void } | null = null;
  private _strategyCleanup: (() => void) | null = null;
  private _pipelineDiagnostics: PipelineStageSnapshot[] | null = null;
  private _arbDiagnostics: Partial<ArbSnapshot> = {};

  readonly slug: string;
  private readonly apiQueue: APIQueue;
  private readonly client: EarlyBirdClient;
  private readonly _log: (msg: string, color?: LogColor) => void;
  private readonly _strategyName: string;
  private readonly _strategy: Strategy;
  private readonly _tracker: WalletTracker;
  private readonly _ticker: TickerTracker;
  private readonly _alwaysLog: boolean;

  constructor(opts: MarketLifecycleOptions) {
    this.slug = opts.slug;
    this.apiQueue = opts.apiQueue;
    this.client = opts.client;
    this._log = opts.log;
    this._strategyName = opts.strategyName;
    this._strategy = opts.strategy;
    this._tracker = opts.tracker;
    this._ticker = opts.ticker;
    this._alwaysLog = opts.alwaysLog ?? false;

    const recovery = opts.recovery;
    if (recovery) {
      this._state = recovery.state;
      this._clobTokenIds = recovery.clobTokenIds;
      this._pendingOrders = recovery.pendingOrders;
      this._orderHistory = recovery.orderHistory;
      if (recovery.state === "STOPPING") this._buyBlocked = true;
      this._orderBook.subscribe(recovery.clobTokenIds);
    }
  }

  get state(): LifecycleState {
    return this._state;
  }
  get pnl(): number {
    return this._pnl;
  }
  get livePnl(): number {
    return this._computeLivePnl();
  }
  get clobTokenIds(): [string, string] | null {
    return this._clobTokenIds;
  }
  get pendingOrders(): PendingOrderSnapshot[] {
    return this._pendingOrders.map(
      ({ onFilled, onExpired, onFailed, ...rest }) => rest,
    );
  }
  get orderHistory(): CompletedOrder[] {
    return this._orderHistory;
  }
  /** Unix ms timestamp when this lifecycle's market slot starts (market opens). */
  get slotStartMs(): number {
    return slotFromSlug(this.slug).startTime;
  }
  /** Unix ms timestamp when this lifecycle's market slot ends. */
  get slotEndMs(): number {
    return slotFromSlug(this.slug).endTime;
  }
  get remainingSecs(): number {
    return (this.slotEndMs - Date.now()) / 1000;
  }
  get strategyName(): string {
    return this._strategyName;
  }

  getDashboardSnapshot(): ActiveMarketSnapshot {
    const now = Date.now();
    const marketData = this.apiQueue.marketResult.get(this.slotStartMs);
    const priceToBeat = marketData?.openPrice ?? null;
    const assetPrice = this._ticker.price ?? null;
    const marketOpen = now >= this.slotStartMs;
    const opensInSecs = Math.max(0, Math.floor((this.slotStartMs - now) / 1000));
    const gap = priceToBeat != null && assetPrice != null
      ? parseFloat((assetPrice - priceToBeat).toFixed(2))
      : null;
    const upAskInfo = this._orderBook.bestAskInfo("UP");
    const downAskInfo = this._orderBook.bestAskInfo("DOWN");
    const upBidInfo = this._orderBook.bestBidInfo("UP");
    const downBidInfo = this._orderBook.bestBidInfo("DOWN");
    const arb = makeArbSnapshot({
      upAsk: upAskInfo,
      downAsk: downAskInfo,
      upBid: upBidInfo,
      downBid: downBidInfo,
      patch: this._arbDiagnostics,
    });
    const pipeline = this._pipelineDiagnostics ?? makePipeline({
      scan: {
        state: upAskInfo && downAskInfo ? "watch" : "idle",
        detail: upAskInfo && downAskInfo ? "Orderbook live" : "Đang chờ orderbook",
      },
      detect: {
        state: arb.edgeCents !== null && arb.edgeCents >= arb.minEdgeCents ? "pass" : "watch",
        detail: arb.sum !== null ? `YES + NO = ${arb.sum.toFixed(2)}, edge ${arb.edgeCents?.toFixed(2)}¢` : "Chưa có đủ YES/NO ask",
      },
      validate: {
        state: arb.executable ? "pass" : "watch",
        detail: arb.executable ? "Edge + depth đạt chuẩn" : "Chờ edge/depth tốt hơn",
      },
      size: {
        state: arb.depthShares !== null && arb.depthShares >= arb.targetShares ? "pass" : "watch",
        detail: `Target ${arb.targetShares} shares`,
      },
      fill: { state: "idle", detail: "Chưa gửi cặp lệnh" },
      hedge: { state: "idle", detail: "Chỉ kích hoạt nếu fill lệch" },
    });

    let upShares = 0;
    let downShares = 0;
    for (const o of this._orderHistory) {
      if (!this._clobTokenIds) break;
      if (o.action === "buy") {
        if (o.tokenId === this._clobTokenIds[0]) upShares += o.shares;
        if (o.tokenId === this._clobTokenIds[1]) downShares += o.shares;
      } else {
        if (o.tokenId === this._clobTokenIds[0]) upShares -= o.shares;
        if (o.tokenId === this._clobTokenIds[1]) downShares -= o.shares;
      }
    }

    const livePnl = this._computeLivePnl();
    arb.livePnl = Number(livePnl.toFixed(4));
    arb.livePnlMode = this._state === "DONE"
      ? "Đã settle"
      : "Tạm tính realtime: cặp đủ 2 phe tính theo payout $1, phe lẻ tính theo best bid";

    let note: string | null = null;
    if (!marketOpen) {
      note = `Market chưa mở, còn ${opensInSecs}s mới có Price to beat và Gap.`;
    } else if (priceToBeat == null) {
      note = "Market đã mở, đang chờ dữ liệu Price to beat từ Polymarket/API.";
    }

    return {
      slug: this.slug,
      state: this._state,
      remainingSecs: Math.max(0, Math.floor(this.remainingSecs)),
      opensInSecs,
      marketOpen,
      assetPrice,
      priceToBeat,
      gap,
      side: gap == null ? "FLAT" : gap > 0 ? "UP" : gap < 0 ? "DOWN" : "FLAT",
      note,
      upAsk: upAskInfo?.price ?? null,
      downAsk: downAskInfo?.price ?? null,
      upBid: upBidInfo?.price ?? null,
      downBid: downBidInfo?.price ?? null,
      position: {
        upShares: Math.max(0, Number(upShares.toFixed(4))),
        downShares: Math.max(0, Number(downShares.toFixed(4))),
      },
      pendingBuys: this._pendingOrders.filter((o) => o.action === "buy").length,
      pendingSells: this._pendingOrders.filter((o) => o.action === "sell").length,
      totalOrders: this._orderHistory.length,
      pipeline,
      arb,
    };
  }

  /** Returns orderbook snapshot for a tokenId owned by this lifecycle. */
  getBookSnapshot(tokenId: string) {
    if (!this._clobTokenIds) return null;
    let side: "UP" | "DOWN" | null = null;
    if (tokenId === this._clobTokenIds[0]) side = "UP";
    else if (tokenId === this._clobTokenIds[1]) side = "DOWN";
    if (!side) return null;
    const askInfo = this._orderBook.bestAskInfo(side);
    const bidInfo = this._orderBook.bestBidInfo(side);
    return {
      bestAsk: askInfo?.price ?? null,
      bestAskLiquidity: askInfo?.liquidity ?? null,
      bestBid: bidInfo?.price ?? null,
      bestBidLiquidity: bidInfo?.liquidity ?? null,
    };
  }

  /**
   * Signal graceful shutdown. INIT lifecycles are marked DONE immediately.
   * RUNNING lifecycles transition to STOPPING on next tick.
   */
  shutdown(): void {
    if (this._state === "INIT") {
      this._setState("DONE");
      return;
    }
    if (this._state === "RUNNING") {
      this._buyBlocked = true;
      this._setState("STOPPING");
    }
    // STOPPING already — no-op
  }

  destroy(): void {
    if (this._orderHistory.length > 0 || this._alwaysLog) {
      this._marketLogger.endSlot(this.slug);
    }
    this._marketLogger.destroy();
    this._marketPriceHandle?.cancel();
    if (this._marketOpenTimer) clearTimeout(this._marketOpenTimer);
    this._strategyCleanup?.();
    this._orderBook.destroy();
    this._log(`[${this.slug}] destroy()`, "dim");
  }

  private _setState(next: LifecycleState): void {
    if (this._state === next) return;
    this._log(`[${this.slug}] state: ${this._state} → ${next}`, "dim");
    this._state = next;
  }

  async tick(): Promise<void> {
    if (this._ticking || this._state === "DONE") return;
    this._ticking = true;
    try {
      await this._step();
    } catch (e) {
      this._log(`[${this.slug}] tick error: ${e}`, "red");
    } finally {
      this._ticking = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Core engine
  // ---------------------------------------------------------------------------

  private async _step(): Promise<void> {
    switch (this._state) {
      case "INIT":
        return this._handleInit();
      case "RUNNING":
        return this._handleRunning();
      case "STOPPING":
        return this._handleStopping();
    }
  }

  /** Fetch market metadata (conditionId, tokenIds, feeRate). Called by both
   *  normal init and recovery so both paths have the same market context. */
  async setup(): Promise<void> {
    await this.apiQueue.queueEventDetails(this.slug);
    const event = this.apiQueue.eventDetails.get(this.slug);
    if (!event) return;
    const market = event.markets[0];
    if (!market) return;

    this._conditionId = market.conditionId;
    if (!this._clobTokenIds) {
      const tokenIds: string[] = JSON.parse(market.clobTokenIds);
      this._clobTokenIds = [tokenIds[0]!, tokenIds[1]!];
    }
    this._feeRate ??= market.feeSchedule?.rate ?? 0;
  }

  private async _handleInit(): Promise<void> {
    await this.setup();
    if (!this._clobTokenIds) return;

    const slot = slotFromSlug(this.slug);
    const delayMs = Math.max(0, slot.startTime - Date.now());
    this._marketOpenTimer = setTimeout(() => {
      this._marketPriceHandle = this.apiQueue.queueMarketPrice(slot);
    }, delayMs);

    this._orderBook.subscribe(this._clobTokenIds);
    this._marketLogger.setSnapshotProvider(() =>
      this._orderBook.getSnapshotData(),
    );
    this._marketLogger.setTickerProvider(() => ({
      assetPrice: this._ticker.price,
      binancePrice: this._ticker.binancePrice,
      coinbasePrice: this._ticker.coinbasePrice,
      divergence: this._ticker.divergence,
    }));
    this._marketLogger.setMarketResultProvider(() => {
      const data = this.apiQueue.marketResult.get(slot.startTime);
      if (!data?.openPrice) return {};
      const assetPrice = this._ticker.price;
      const gap = assetPrice
        ? parseFloat((assetPrice - data.openPrice).toFixed(2))
        : undefined;
      return { openPrice: data.openPrice, gap, priceToBeat: data.openPrice };
    });
    this._marketLogger.startSlot(
      this.slug,
      Date.now(),
      this.slotEndMs,
      this._strategyName,
    );

    const ctx: StrategyContext = {
      slug: this.slug,
      slotStartMs: this.slotStartMs,
      slotEndMs: this.slotEndMs,
      clobTokenIds: this._clobTokenIds,
      orderBook: this._orderBook,
      log: this._log,
      getOrderById: this.client.getOrderById.bind(this.client),
      postOrders: this._postOrders.bind(this),
      cancelOrders: this._cancelOrders.bind(this),
      emergencySells: this._emergencySells.bind(this),
      blockBuys: () => {
        this._buyBlocked = true;
      },
      blockSells: () => {
        this._sellBlocked = true;
      },
      pendingOrders: this._pendingOrders,
      orderHistory: this._orderHistory,
      hold: () => {
        this._strategyLocks++;
        let released = false;
        return () => {
          if (!released) {
            released = true;
            this._strategyLocks--;
          }
        };
      },
      ticker: this._ticker,
      getMarketResult: () => {
        const slot = slotFromSlug(this.slug);
        return this.apiQueue.marketResult.get(slot.startTime);
      },
      setDiagnostics: (patch) => {
        if (patch.pipeline) this._pipelineDiagnostics = patch.pipeline;
        if (patch.arb) this._arbDiagnostics = { ...this._arbDiagnostics, ...patch.arb };
      },
    };

    await this._orderBook.waitForReady();

    const cleanup = await this._strategy(ctx);
    if (cleanup) this._strategyCleanup = cleanup;
    this._setState("RUNNING");
  }

  /**
   * Generic tick for RUNNING: check every pending order for fill or expiry,
   * fire callbacks. Transitions to STOPPING when the slot ends or all orders drain.
   */
  private async _handleRunning(): Promise<void> {
    if (Date.now() >= this.slotEndMs) {
      this._setState("STOPPING");
      this._log(
        `[${this.slug}] Market closed — transitioning to STOPPING`,
        "yellow",
      );
      return;
    }

    await this._processPendingOrders();

    // If no pending orders remain, no placements in flight, no strategy holds,
    // and no unfilled positions that a stop-loss may still sell, we're done
    if (
      this._pendingOrders.length === 0 &&
      this._inFlight === 0 &&
      this._strategyLocks === 0 &&
      !this._hasUnfilledPositions()
    ) {
      this._setState("STOPPING");
    }
  }

  /**
   * STOPPING: cancel pending buys, drain sells, emergency sell on timeout.
   */
  private async _handleStopping(): Promise<void> {
    // Cancel any remaining buys (in case shutdown was called externally)
    await this._cancelPendingBuys();

    const pendingSells = this._pendingOrders.filter((o) => o.action === "sell");

    const remaining = this.remainingSecs;

    if (remaining <= 0) {
      // Slot expired — cancel whatever is left
      if (pendingSells.length > 0) {
        this._log(
          `[${this.slug}] Slot expired with ${pendingSells.length} unfilled SELL order(s) — cancelling`,
          "yellow",
        );
        const response = await this._cancelOrders(
          pendingSells.map((o) => o.orderId),
        );
        // Force-remove any not_canceled (slot is over, nothing we can do)
        for (const id of Object.keys(response.not_canceled)) {
          this._removePendingOrder(id);
        }
      }
      await this._waitForResolution();
      this._computePnl();
      await this._autoRedeem();
      this._setState("DONE");
      return;
    }

    // Process sells normally (check fills, expiries)
    await this._processPendingOrders();

    if (this._pendingOrders.length === 0 && this._inFlight === 0) {
      if (this._hasUnfilledPositions()) {
        await this._waitForResolution();
        this._computePnl();
        await this._autoRedeem();
      } else {
        this._computePnl();
      }
      this._setState("DONE");
    }
  }

  /**
   * Check all pending orders for fill or expiry. Fire callbacks.
   * Callbacks may enqueue new pending orders, which will be picked up next tick.
   */
  private async _processPendingOrders(): Promise<void> {
    if (this._pendingOrders.length == 0) return;

    // Snapshot the list — callbacks may mutate _pendingOrders
    const snapshot = [...this._pendingOrders];

    // Fetch full status for every pending order directly.
    // This correctly handles immediate fills (order filled before appearing in open
    // order list) as well as cancelled orders, without relying on getOpenOrderIds.
    const CLOB_INDEX_GRACE_MS = 5000;
    const statuses = await Promise.all(
      snapshot.map((p) => this.client.getOrderById(p.orderId)),
    );
    const statusMap = new Map<string, Order | null>(
      snapshot.map((p, i) => [p.orderId, statuses[i]!]),
    );

    const commitFill = (pending: PendingOrder, shares: number, fee = 0) => {
      if (pending.action === "buy") {
        this._tracker.onBuyFilled(
          pending.orderId,
          pending.tokenId,
          pending.price,
          shares,
        );
      } else {
        this._tracker.onSellFilled(
          pending.orderId,
          pending.tokenId,
          pending.price,
          shares,
        );
      }
      this._orderHistory.push({
        action: pending.action,
        price: pending.price,
        shares,
        fee,
        tokenId: pending.tokenId,
      });
      this._removePendingOrder(pending.orderId);
      this._marketLogger.log(
        this._createOrderEntry(pending, "filled", { shares }),
      );
      if (pending.onFilled) pending.onFilled(shares);
    };

    for (const pending of snapshot) {
      // Skip if already removed by a prior callback in this tick
      if (!this._pendingOrders.includes(pending)) continue;

      const order = statusMap.get(pending.orderId);

      if (order?.status === "live") {
        // Still live — only check expiry
        if (Date.now() >= pending.expireAtMs) {
          await this._cancelOrders([pending.orderId]);
          const partialShares = order.actualShares ?? 0;
          if (partialShares > 0) {
            // Partial fill — treat matched shares as a fill, ignore unmatched remainder
            commitFill(pending, partialShares);
          } else if (pending.onExpired) {
            this._marketLogger.log(this._createOrderEntry(pending, "expired"));
            await pending.onExpired();
          }
        }
        continue;
      }

      // null within grace period — CLOB may not have indexed the order yet
      // this is only for prod client not simulated client
      if (!order && Date.now() - pending.placedAtMs <= CLOB_INDEX_GRACE_MS)
        continue;

      if (!order || order.status === "cancelled") {
        const reason = order ? "cancelled" : "not found";
        this._removePendingOrder(pending.orderId);
        this._trackerUnlock(pending);
        this._marketLogger.log(
          this._createOrderEntry(pending, "failed", { reason }),
        );
        if (pending.onFailed) await pending.onFailed(reason);
        continue;
      }

      if (order.status === "filled") {
        const grossShares =
          order.actualShares > 0 ? order.actualShares : order.shares;
        let fee = 0;
        if (pending.orderType === "FOK" && this._feeRate > 0) {
          // Taker fee: fee = C × feeRate × p × (1 - p)
          fee =
            grossShares * this._feeRate * pending.price * (1 - pending.price);
        }
        // Buy fee is deducted in shares, avoids double-counting since fee we price * grossed shares in pnl
        const shares =
          pending.action === "buy" && fee > 0
            ? grossShares - fee / pending.price
            : grossShares;
        commitFill(pending, shares, fee);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Strategy-facing order APIs
  // ---------------------------------------------------------------------------

  /**
   * Fire-and-forget order placement. Returns immediately — do NOT await the
   * result to know if an order was placed. Use `onFilled` to react to a fill
   * and `onExpired` to react to a cancellation or failed placement.
   *
   * Buys retry up to 30 times on balance errors; sells retry until slot end.
   */
  private _postOrders(requests: OrderRequest[]): void {
    const buys = requests.filter(
      (o) => o.req.action === "buy" && !this._buyBlocked,
    );
    const sells = requests.filter(
      (o) => o.req.action === "sell" && !this._sellBlocked,
    );

    if (buys.length > 0) this._placeWithRetry(buys, 500, 30);
    if (sells.length > 0) this._placeWithRetry(sells, 500, Infinity);
  }

  private async _cancelOrders(
    orderIds: string[],
  ): Promise<CancelOrderResponse> {
    const response = await this.client.cancelOrders(orderIds);
    for (const id of response.canceled) {
      const pending = this._pendingOrders.find((o) => o.orderId === id);
      if (pending) {
        this._trackerUnlock(pending);
        this._marketLogger.log(this._createOrderEntry(pending, "canceled"));
      }
      this._removePendingOrder(id);
    }
    return response;
  }

  private async _emergencySells(orderIds: string[]): Promise<void> {
    const sells = orderIds
      .map((id) =>
        this._pendingOrders.find(
          (o) => o.orderId === id && o.action === "sell",
        ),
      )
      .filter((o): o is PendingOrder => !!o);

    if (sells.length === 0) return;

    // Cancel all in batch
    const response = await this._cancelOrders(sells.map((o) => o.orderId));
    const canceledSells = sells.filter((s) =>
      response.canceled.includes(s.orderId),
    );

    if (canceledSells.length === 0) return;

    // Re-place each sell as FOK at current best bid, retrying until filled or slot ends
    for (const sell of canceledSells) {
      this._emergencySellLoop(sell);
    }
  }

  /**
   * Places a GTC sell at the current best bid and retries on rejection until
   * the order fills or the slot ends. Each retry reads a fresh best bid so the
   * price tracks the market.
   */
  private _emergencySellLoop(sell: PendingOrder): void {
    this._inFlight++;
    (async () => {
      while (Date.now() < this.slotEndMs) {
        const side = sell.tokenId === this._clobTokenIds![0] ? "UP" : "DOWN";
        const bestBid =
          this._orderBook.bestBidPrice(side as "UP" | "DOWN") ?? sell.price;

        let filled = false;
        let failed = false;

        await new Promise<void>((resolve) => {
          this._placeWithRetry([
            {
              req: {
                tokenId: sell.tokenId,
                action: "sell" as const,
                price: bestBid,
                shares: sell.shares,
                orderType: "GTC" as const,
              },
              expireAtMs: Date.now() + 2000,
              onFilled: (_filledShares) => {
                filled = true;
                resolve();
              },
              onFailed: (reason) => {
                if (!reason.includes("not enough balance")) failed = true;
                resolve();
              },
              onExpired: () => {
                // GTC expired after 2s — retry with fresh bid
                failed = true;
                resolve();
              },
            },
          ]);
        });

        if (filled) break;
        if (!failed) break; // unexpected stop (e.g. sell blocked)
      }
    })()
      .catch((e) =>
        this._log(`[${this.slug}] _emergencySellLoop error: ${e}`, "red"),
      )
      .finally(() => {
        this._inFlight--;
      });
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Fire-and-forget: places orders and retries any that fail with a balance
   * error (350 ms apart) until the slot ends or all orders are placed.
   */
  private _placeWithRetry(
    items: Array<OrderRequest>,
    retryDelayMs = 350,
    maxRetries = Infinity,
  ): void {
    this._inFlight++;
    (async () => {
      let remaining = [...items];
      let retryCount = 0;
      while (remaining.length > 0) {
        // Stop retrying if the relevant block flag was set after this loop started
        const beforeBlock = remaining.length;
        remaining = remaining.filter((item) => {
          if (item.req.action === "buy" && this._buyBlocked) return false;
          if (item.req.action === "sell" && this._sellBlocked) return false;
          return true;
        });
        if (remaining.length === 0) {
          // log if blocked, take 0 item assuming all item kinds are same from postOrder
          if (beforeBlock > 0) {
            const kind = items[0]!.req.action === "buy" ? "buy" : "sell";
            this._log(
              `[${this.slug}] Retry stopped: ${kind} is blocked`,
              "yellow",
            );
          }
          break;
        }

        // Pre-flight: drop orders past their expiry
        remaining = remaining.filter((item) => {
          if (Date.now() >= item.expireAtMs) {
            if (item.onFailed) item.onFailed("order expired before placement");
            return false;
          }
          return true;
        });
        if (remaining.length === 0) break;

        // Pre-flight: skip network call for orders the tracker knows will fail
        const retryNext: typeof remaining = [];
        remaining = remaining.filter((item) => {
          const ok =
            item.req.action === "buy"
              ? this._tracker.canPlaceBuy(item.req.price, item.req.shares)
              : this._tracker.canPlaceSell(item.req.tokenId, item.req.shares);
          if (!ok) retryNext.push(item);
          return ok;
        });
        if (remaining.length === 0) {
          if (retryCount === 0) {
            // log if balance too low, take 0 item assuming all item kinds are same from postOrder
            const kind = retryNext[0]!.req.action === "buy" ? "buy" : "sell";
            this._log(
              `[${this.slug}] Retry stopped: wallet balance too low to place ${kind}`,
              "yellow",
            );
          }
          remaining = retryNext;
          retryCount++;
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }

        const placed = await this.client.postMultipleOrders(
          remaining.map((r) => ({
            ...r.req,
            tickSize: this._orderBook.getTickSize(r.req.tokenId),
            feeRateBps: this._orderBook.getFeeRate(r.req.tokenId),
            negRisk: false,
          })),
        );

        for (let i = 0; i < placed.length; i++) {
          const p = placed[i];
          const item = remaining[i]!;
          if (!p || !p.orderId) {
            if (
              p?.errorMsg?.includes("not enough balance") &&
              Date.now() < this.slotEndMs &&
              retryCount < maxRetries
            ) {
              // Parse actual balance from CLOB error and adjust shares
              const balMatch = p.errorMsg.match(
                /balance:\s*(\d+).*?order amount:\s*(\d+)/,
              );
              if (balMatch) {
                const actualBalance = parseInt(balMatch[1]!, 10);
                const orderAmount = parseInt(balMatch[2]!, 10);
                if (actualBalance > 0 && actualBalance < orderAmount) {
                  item.req.shares = actualBalance / 1e6;
                }
              }
              retryNext.push(item);
            } else {
              const reason = p?.errorMsg ?? "unknown";
              const side =
                item.req.tokenId === this._clobTokenIds?.[0] ? "UP" : "DOWN";
              this._log(
                `[${this.slug}] Order placement failed (${item.req.action.toUpperCase()} ${side} @ ${item.req.price}): ${reason}`,
                "red",
              );
              if (item.onFailed) item.onFailed(reason);
            }
            continue;
          }
          this._trackerLock(item, p);
          this._pendingOrders.push({
            orderId: p.orderId,
            tokenId: item.req.tokenId,
            action: item.req.action,
            orderType: item.req.orderType,
            price: item.req.price,
            shares: item.req.shares,
            expireAtMs: item.expireAtMs,
            placedAtMs: Date.now(),
            onFilled: item.onFilled,
            onExpired: item.onExpired,
            onFailed: item.onFailed,
          });
          this._marketLogger.log(this._createOrderEntry(item.req, "placed"));
        }

        if (retryNext.length === 0) break;
        remaining = retryNext;
        retryCount++;
        if (retryCount % 5 === 0) {
          const summary = retryNext
            .map((r) => {
              const side =
                r.req.tokenId === this._clobTokenIds?.[0] ? "UP" : "DOWN";
              return `${r.req.action.toUpperCase()} ${side} @ ${r.req.price} (shares: ${r.req.shares})`;
            })
            .join(", ");
          const errors = placed
            ?.filter((p) => p?.errorMsg)
            .map((p) => p!.errorMsg)
            .join("; ");
          this._log(
            `[${this.slug}] Balance not ready — retrying (attempt ${retryCount}): ${summary} | error: ${errors || "pre-flight rejected"}`,
            "yellow",
          );
        }
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    })()
      .catch((e) =>
        this._log(`[${this.slug}] _placeWithRetry error: ${e}`, "red"),
      )
      .finally(() => {
        this._inFlight--;
      });
  }

  private _removePendingOrder(orderId: string): void {
    const idx = this._pendingOrders.findIndex((o) => o.orderId === orderId);
    if (idx !== -1) this._pendingOrders.splice(idx, 1);
  }

  private async _cancelPendingBuys(): Promise<void> {
    const buys = this._pendingOrders.filter((o) => o.action === "buy");
    if (buys.length === 0) return;

    this._log(
      `[${this.slug}] Cancelling ${buys.length} pending BUY order(s)`,
      "yellow",
    );
    await this._cancelOrders(buys.map((o) => o.orderId));
  }

  private _side(tokenId: string): "UP" | "DOWN" {
    return tokenId === this._clobTokenIds?.[0] ? "UP" : "DOWN";
  }

  private _createOrderEntry(
    order: {
      action: "buy" | "sell";
      tokenId: string;
      price: number;
      shares: number;
    },
    status: "placed" | "filled" | "failed" | "expired" | "canceled",
    opts?: { shares?: number; reason?: string },
  ) {
    return {
      type: "order" as const,
      action: order.action,
      side: this._side(order.tokenId),
      price: order.price,
      shares: opts?.shares ?? order.shares,
      status,
      reason: opts?.reason,
    };
  }

  /** Lock tracker reservation for a pending order (buy or sell). */
  private _trackerLock(req: OrderRequest, order: PlacedOrder): void {
    const side = this._side(req.req.tokenId);
    const label = `[${this.slug}] ${req.req.action.toUpperCase()} ${side} @ ${req.req.price}`;
    if (req.req.action === "buy") {
      this._tracker.lockForBuy(
        order.orderId,
        req.req.price,
        req.req.shares,
        label,
      );
    } else {
      this._tracker.lockForSell(
        order.orderId,
        req.req.tokenId,
        req.req.shares,
        label,
      );
    }
  }

  /** Unlock tracker reservation for a pending order (buy or sell). */
  private _trackerUnlock(pending: PendingOrder): void {
    const side = this._side(pending.tokenId);
    const label = `[${this.slug}] ${pending.action.toUpperCase()} ${side} @ ${pending.price}`;
    if (pending.action === "buy")
      this._tracker.unlockBuy(pending.orderId, label);
    else this._tracker.unlockSell(pending.orderId, label);
  }

  private _computeLivePnl(): number {
    let pnl = 0;
    const held = new Map<string, number>();

    for (const o of this._orderHistory) {
      if (o.action === "sell") pnl += o.price * o.shares;
      else pnl -= o.price * o.shares;
      pnl -= o.fee ?? 0;

      const cur = held.get(o.tokenId) ?? 0;
      if (o.action === "buy") held.set(o.tokenId, cur + o.shares);
      else held.set(o.tokenId, cur - o.shares);
    }

    if (!this._clobTokenIds) return Number(pnl.toFixed(4));

    const upToken = this._clobTokenIds[0];
    const downToken = this._clobTokenIds[1];
    const upHeld = Math.max(0, held.get(upToken) ?? 0);
    const downHeld = Math.max(0, held.get(downToken) ?? 0);

    const slot = slotFromSlug(this.slug);
    const data = this.apiQueue.marketResult.get(slot.startTime);
    if (data?.closePrice) {
      const resolvedUp = data.closePrice > data.openPrice;
      pnl += resolvedUp ? upHeld : downHeld;
      return Number(pnl.toFixed(4));
    }

    // If both sides are held, paired shares have a known settle value of $1.
    // This updates the dashboard immediately after hedge fill instead of waiting for settlement.
    const paired = Math.min(upHeld, downHeld);
    pnl += paired * 1.0;

    const upExtra = Math.max(0, upHeld - paired);
    const downExtra = Math.max(0, downHeld - paired);
    const upBid = this._orderBook.bestBidInfo("UP")?.price ?? 0;
    const downBid = this._orderBook.bestBidInfo("DOWN")?.price ?? 0;
    pnl += upExtra * upBid;
    pnl += downExtra * downBid;

    return Number(pnl.toFixed(4));
  }

  private _hasUnfilledPositions(): boolean {
    const held = new Map<string, number>();
    for (const o of this._orderHistory) {
      const cur = held.get(o.tokenId) ?? 0;
      if (o.action === "buy") held.set(o.tokenId, cur + o.shares);
      else held.set(o.tokenId, cur - o.shares);
    }
    for (const shares of held.values()) {
      if (shares > 0) return true;
    }
    return false;
  }

  private async _autoRedeem(): Promise<void> {
    if (!Env.get("PROD")) return;
    if (!this._conditionId) return; // belt-and-suspenders

    this._log(`[${this.slug}] Redeeming positions...`, "dim");
    try {
      await this.client.redeemPositions(this._conditionId, true);
      this._log(`[${this.slug}] Redemption successful`, "green");
    } catch (e) {
      this._log(`[${this.slug}] Redemption failed: ${e}`, "red");
    }
  }

  private async _waitForResolution(): Promise<void> {
    const slot = slotFromSlug(this.slug);
    if (!this._marketPriceHandle) {
      this._marketPriceHandle = this.apiQueue.queueMarketPrice(slot);
    }
    while (true) {
      const data = this.apiQueue.marketResult.get(slot.startTime);
      if (data?.closePrice) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private _computePnl(): void {
    let pnl = 0;
    const held = new Map<string, number>();

    for (const o of this._orderHistory) {
      if (o.action === "sell") pnl += o.price * o.shares;
      else pnl -= o.price * o.shares;
      pnl -= o.fee ?? 0;

      const cur = held.get(o.tokenId) ?? 0;
      if (o.action === "buy") held.set(o.tokenId, cur + o.shares);
      else held.set(o.tokenId, cur - o.shares);
    }

    const slot = slotFromSlug(this.slug);
    const data = this.apiQueue.marketResult.get(slot.startTime);

    if (data?.closePrice) {
      const resolvedUp = data.closePrice > data.openPrice;
      const upToken = this._clobTokenIds![0];
      let unfilledShares = 0;
      let payout = 0;

      for (const [tokenId, shares] of held) {
        if (shares <= 0) continue;
        unfilledShares += shares;
        const isUp = tokenId === upToken;
        const payoutPerShare =
          (resolvedUp && isUp) || (!resolvedUp && !isUp) ? 1.0 : 0.0;
        payout += shares * payoutPerShare;
      }
      pnl += payout;

      this._tracker.onResolution(held, payout);
      this._pnl = parseFloat(pnl.toFixed(4));
      this._log(
        `[${this.slug}] Resolved ${resolvedUp ? "UP" : "DOWN"}. PnL: ${this._pnl >= 0 ? "+" : ""}$${this._pnl.toFixed(2)}`,
        this._pnl >= 0 ? "green" : "red",
      );
      this._marketLogger.log({
        type: "resolution",
        direction: resolvedUp ? "UP" : "DOWN",
        openPrice: data.openPrice,
        closePrice: data.closePrice,
        unfilledShares,
        payout,
        pnl: this._pnl,
      });
    } else {
      this._pnl = parseFloat(pnl.toFixed(4));
      this._log(
        `[${this.slug}] Settled. PnL: ${this._pnl >= 0 ? "+" : ""}$${this._pnl.toFixed(2)}`,
        this._pnl >= 0 ? "green" : "red",
      );
    }
  }
}
