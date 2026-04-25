import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

export type TradeFeedItem = {
  time: string;
  message: string;
  type: "buy" | "sell" | "resolved" | "signal" | "arb" | "hedge" | "info";
};

export type BalancePoint = {
  time: string;
  balance: number;
};

export type PipelineStageState = "idle" | "watch" | "pass" | "warn" | "fail";

export type PipelineStageSnapshot = {
  key: "scan" | "detect" | "validate" | "size" | "fill" | "hedge";
  label: string;
  state: PipelineStageState;
  detail: string;
  updatedAt: string | null;
};

export type ArbSnapshot = {
  yesAsk: number | null;
  noAsk: number | null;
  yesBid: number | null;
  noBid: number | null;
  yesLiquidity: number | null;
  noLiquidity: number | null;
  sum: number | null;
  edge: number | null;
  edgeCents: number | null;
  minEdgeCents: number;
  maxEntrySum: number;
  executable: boolean;
  targetShares: number;
  depthShares: number | null;
  capitalNeeded: number | null;
  capitalUsed: number;
  fillLatencyMs: number | null;
  trades: number;
  lastAction: string | null;
  lastTrigger: string | null;
  riskNote: string | null;

  // Hybrid Gap + 6-Layer fields. Optional so older strategies still work.
  mode?: "PURE_ARB" | "GAP_FIRST_LEG" | "WAIT_HEDGE" | "LOCKED" | "RESCUE" | "HOLD_ONE_SIDE" | "IDLE" | null;
  gapSignal?: "BUY" | "SELL" | "FLAT" | null;
  gapInvertSignal?: boolean | null;
  gapSignalEnabled?: boolean | null;
  pureArbEnabled?: boolean | null;
  waitReason?: string | null;
  waitReasons?: string | null;
  firstLegSide?: "BUY" | "SELL" | null;
  firstLegPrice?: number | null;
  firstLegShares?: number | null;
  firstLegAgeMs?: number | null;
  hedgeSide?: "BUY" | "SELL" | null;
  hedgeMaxPrice?: number | null;
  hedgeAsk?: number | null;
  lockSum?: number | null;
  lockedEdgeCents?: number | null;
  rescueReason?: string | null;

  // V4: live PNL + smart hedge bottom/reversal tracking.
  livePnl?: number | null;
  livePnlMode?: string | null;
  lowestHedgeAsk?: number | null;
  hedgeReboundCents?: number | null;
  smartHedgeTrigger?: string | null;

  // V10: fast profit lock / pixel dashboard fields.
  profitLockEnabled?: boolean | null;
  profitMaxSum?: number | null;
  lockSumLimit?: number | null;
  profitSumLimit?: number | null;
  profitIfLocked?: number | null;

  // V8/V9 diagnostics.
  startOnlyNewSlot?: boolean | null;
  entryMaxOpenedSecs?: number | null;
  entryMinRemainingSecs?: number | null;
  startupSkipped?: boolean | null;
  openedForSecs?: number | null;
  remainingSecs?: number | null;
  smartHedgeLockSeenAgeMs?: number | null;
  smartHedgeTakeEdgeCents?: number | null;
  smartHedgeDecisionMs?: number | null;

  // V13: hold one side / no hedge above bad SUM.
  oneSideHoldEnabled?: boolean | null;
  oneSideHoldAboveSum?: number | null;
  oneSideHoldActive?: boolean | null;
  oneSideHoldPermanent?: boolean | null;
  oneSideHoldReason?: string | null;
};

export type ActiveMarketSnapshot = {
  slug: string;
  state: string;
  remainingSecs: number;
  opensInSecs: number;
  marketOpen: boolean;
  assetPrice: number | null;
  priceToBeat: number | null;
  gap: number | null;
  side: "UP" | "DOWN" | "FLAT";
  note: string | null;
  upAsk: number | null;
  downAsk: number | null;
  upBid: number | null;
  downBid: number | null;
  position: {
    upShares: number;
    downShares: number;
  };
  pendingBuys: number;
  pendingSells: number;
  totalOrders: number;
  pipeline: PipelineStageSnapshot[];
  arb: ArbSnapshot;
};

export type DashboardState = {
  startedAt: string | null;
  strategy: string;
  mode: "SIM" | "PROD";
  asset: string;
  marketWindow: string;
  initialBalance: number;
  balance: number;
  available: number;
  sessionPnl: number;
  sessionLoss: number;
  wins: number;
  losses: number;
  completedMarkets: number;
  uptimeSecs: number;
  activeMarkets: ActiveMarketSnapshot[];
  recentLogs: { time: string; msg: string }[];
  tradeFeed: TradeFeedItem[];
  balanceHistory: BalancePoint[];
  status: string;
  control: {
    paused: boolean;
    process: "unknown" | "running" | "stopped";
    lastCommand: string;
    updatedAt: string | null;
  };
};

const FILE_PATH = "state/dashboard.json";
const MAX_RECENT_LOGS = 120;
const MAX_TRADE_FEED = 60;
const MAX_BALANCE_POINTS = 300;

class DashboardStateWriter {
  private _lastFlushMs = 0;
  private _state: DashboardState = {
    startedAt: null,
    strategy: "",
    mode: "SIM",
    asset: "BTC",
    marketWindow: "5m",
    initialBalance: 0,
    balance: 0,
    available: 0,
    sessionPnl: 0,
    sessionLoss: 0,
    wins: 0,
    losses: 0,
    completedMarkets: 0,
    uptimeSecs: 0,
    activeMarkets: [],
    recentLogs: [],
    tradeFeed: [],
    balanceHistory: [],
    status: "Đang chờ bot khởi động...",
    control: {
      paused: false,
      process: "unknown",
      lastCommand: "idle",
      updatedAt: null,
    },
  };

  startSession(params: {
    strategy: string;
    mode: "SIM" | "PROD";
    asset: string;
    marketWindow: string;
    initialBalance: number;
  }) {
    const now = new Date().toISOString();
    const keepHistory = process.env.DASHBOARD_KEEP_HISTORY !== "false";
    if (keepHistory && existsSync(FILE_PATH)) {
      try {
        const old = JSON.parse(readFileSync(FILE_PATH, "utf8")) as Partial<DashboardState>;
        this._state.recentLogs = old.recentLogs ?? this._state.recentLogs;
        this._state.tradeFeed = old.tradeFeed ?? this._state.tradeFeed;
        this._state.balanceHistory = old.balanceHistory ?? this._state.balanceHistory;
      } catch {
        // ignore corrupt dashboard file; start fresh
      }
    }

    this._state.startedAt = now;
    this._state.strategy = params.strategy;
    this._state.mode = params.mode;
    this._state.asset = params.asset;
    this._state.marketWindow = params.marketWindow;
    this._state.initialBalance = Number(params.initialBalance.toFixed(4));
    this._state.balance = Number(params.initialBalance.toFixed(4));
    this._state.available = Number(params.initialBalance.toFixed(4));
    this._state.sessionPnl = 0;
    this._state.sessionLoss = 0;
    this._state.wins = 0;
    this._state.losses = 0;
    this._state.completedMarkets = 0;
    this._state.activeMarkets = [];
    this._state.balanceHistory.push({ time: now, balance: params.initialBalance });
    if (this._state.balanceHistory.length > MAX_BALANCE_POINTS) {
      this._state.balanceHistory.splice(0, this._state.balanceHistory.length - MAX_BALANCE_POINTS);
    }
    this._state.status = params.strategy === "gap-six-layer-arb"
      ? "Hybrid GAP + 6-Layer Engine đã khởi động"
      : params.strategy === "six-layer-arb"
        ? "6-Layer Arbitrage Engine đã khởi động"
        : "Bot đã khởi động realtime cùng Polymarket";
    this._state.control.process = "running";
    this.flush(true);
  }

  setStatus(status: string) {
    this._state.status = status;
    this.flush();
  }

  updateWallet(snapshot: { balance: number; available: number }) {
    this._state.balance = Number(snapshot.balance.toFixed(4));
    this._state.available = Number(snapshot.available.toFixed(4));
    const time = new Date().toISOString();
    const last = this._state.balanceHistory[this._state.balanceHistory.length - 1];
    if (!last || Math.abs(last.balance - snapshot.balance) > 0.0001) {
      this._state.balanceHistory.push({ time, balance: snapshot.balance });
      if (this._state.balanceHistory.length > MAX_BALANCE_POINTS) {
        this._state.balanceHistory.splice(0, this._state.balanceHistory.length - MAX_BALANCE_POINTS);
      }
    }
    this.flush(true);
  }

  updateCore(data: {
    sessionPnl: number;
    sessionLoss: number;
    wins: number;
    losses: number;
    completedMarkets: number;
    activeMarkets: ActiveMarketSnapshot[];
  }) {
    this._state.sessionPnl = Number(data.sessionPnl.toFixed(4));
    this._state.sessionLoss = Number(data.sessionLoss.toFixed(4));
    this._state.wins = data.wins;
    this._state.losses = data.losses;
    this._state.completedMarkets = data.completedMarkets;
    this._state.activeMarkets = [...data.activeMarkets].sort((a, b) => {
      const aOpen = a.marketOpen ? 1 : 0;
      const bOpen = b.marketOpen ? 1 : 0;
      if (aOpen !== bOpen) return bOpen - aOpen;
      const aRun = a.state === "RUNNING" ? 1 : 0;
      const bRun = b.state === "RUNNING" ? 1 : 0;
      if (aRun !== bRun) return bRun - aRun;
      return b.slug.localeCompare(a.slug);
    });
    if (this._state.startedAt) {
      this._state.uptimeSecs = Math.max(
        0,
        Math.floor((Date.now() - Date.parse(this._state.startedAt)) / 1000),
      );
    }
    this.flush();
  }

  pushLog(msg: string) {
    const time = new Date().toISOString();
    this._state.recentLogs.push({ time, msg });
    if (this._state.recentLogs.length > MAX_RECENT_LOGS) {
      this._state.recentLogs.splice(0, this._state.recentLogs.length - MAX_RECENT_LOGS);
    }

    let type: TradeFeedItem["type"] | null = null;
    const lower = msg.toLowerCase();
    if (lower.includes("arb:") || lower.includes("six-layer") || lower.includes("edge")) {
      type = "arb";
    } else if (lower.includes("hedge") || lower.includes("rescue") || lower.includes("unbalanced")) {
      type = "hedge";
    } else if (msg.includes("BUY ") || msg.includes(" lockBuy ") || msg.includes("buyFill")) {
      type = "buy";
    } else if (msg.includes("SELL ") || msg.includes("sellFill")) {
      type = "sell";
    } else if (msg.includes("Resolved ")) {
      type = "resolved";
    } else if (msg.includes("signal ")) {
      type = "signal";
    }

    if (type) {
      this._state.tradeFeed.unshift({ time, message: msg, type });
      if (this._state.tradeFeed.length > MAX_TRADE_FEED) {
        this._state.tradeFeed.length = MAX_TRADE_FEED;
      }
      this.flush(true);
      return;
    }
    this.flush();
  }

  updateControl(data: Partial<DashboardState["control"]>) {
    this._state.control = { ...this._state.control, ...data };
    this.flush();
  }

  flush(force = false) {
    const now = Date.now();
    if (!force && now - this._lastFlushMs < 250) return;
    this._lastFlushMs = now;
    mkdirSync("state", { recursive: true });
    writeFileSync(FILE_PATH, JSON.stringify(this._state, null, 2), "utf8");
  }
}

export const dashboardState = new DashboardStateWriter();
