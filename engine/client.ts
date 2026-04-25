import type { Order, CancelOrderResponse } from "../utils/trading";
import {
  ClobClient,
  Side,
  OrderType as ClobOrderType,
  type UserOrder,
  AssetType,
  type TickSize,
} from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { RelayClient, RelayerTxType } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { createWalletClient, encodeFunctionData, http, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { Env } from "../utils/config";

const RELAYER_URL = "https://relayer-v2.polymarket.com";
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const CTF_REDEEM_ABI = [
  {
    inputs: [
      { internalType: "address", name: "collateralToken", type: "address" },
      { internalType: "bytes32", name: "parentCollectionId", type: "bytes32" },
      { internalType: "bytes32", name: "conditionId", type: "bytes32" },
      { internalType: "uint256[]", name: "indexSets", type: "uint256[]" },
    ],
    name: "redeemPositions",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

function simulateDelay() {
  const ms = 150 + Math.random() * 10; // 150–160ms
  return new Promise((r) => setTimeout(r, ms));
}

export type MultiOrderRequest = {
  tokenId: string;
  action: "buy" | "sell";
  price: number;
  shares: number;
  tickSize: string;
  negRisk: boolean;
  feeRateBps: number;
  orderType?: "GTC" | "FOK";
};

export type PlacedOrder = {
  orderId: string;
  status: string;
  success: boolean;
  errorMsg: string;
};

export interface EarlyBirdClient {
  init(): Promise<void>;
  postMultipleOrders(orders: MultiOrderRequest[]): Promise<PlacedOrder[]>;
  getOpenOrderIds(conditionId: string): Promise<Set<string>>;
  getOrderById(orderId: string): Promise<Order | null>;
  cancelOrder(orderId: string): Promise<void>;
  cancelOrders(orderIds: string[]): Promise<CancelOrderResponse>;
  /** Re-insert a persisted order (for startup recovery). No-op for real client. */
  restoreOrder(order: Order): void;

  /** Balance API */
  getUSDCBalance(): Promise<number>;
  getAvailableShares(tokenId: string): Promise<number>;
  updateUSDCBalance(): Promise<void>;
  updateAvailableShares(tokenId: string): Promise<void>;

  /** Redeem winning CTF positions for a resolved market. No-op in sim mode. */
  redeemPositions(conditionId: string, silent?: boolean): Promise<void>;
}

export type BookSnapshot = {
  bestAsk: number | null;
  bestAskLiquidity: number | null;
  bestBid: number | null;
  bestBidLiquidity: number | null;
};

/**
 * Sim fill model for fast arb testing.
 * - FOK still needs enough liquidity for the full requested shares.
 * - GTC can report partial matched shares, so strategy can hedge in chunks.
 * This fixes cases where price touches a great level, e.g. BUY 0.24, but depth
 * is not enough for the whole target size.
 */
function simMatchedShares(
  order: { action: "buy" | "sell"; price: number; shares: number },
  book: BookSnapshot,
): number {
  if (order.action === "buy") {
    if (book.bestAsk === null || book.bestAsk > order.price) return 0;
    const liquidity = book.bestAskLiquidity ?? 0;
    const availableShares = book.bestAsk > 0 ? liquidity / book.bestAsk : 0;
    return Math.max(0, Math.min(order.shares, availableShares));
  }
  if (book.bestBid === null || book.bestBid < order.price) return 0;
  const liquidity = book.bestBidLiquidity ?? 0;
  const availableShares = book.bestBid > 0 ? liquidity / book.bestBid : 0;
  return Math.max(0, Math.min(order.shares, availableShares));
}

function isSimFilled(
  order: { action: "buy" | "sell"; price: number; shares: number },
  book: BookSnapshot,
): boolean {
  return simMatchedShares(order, book) + 1e-9 >= order.shares;
}

/** How long after a buy fills before the sim allows sells on that token. */
const SIM_BALANCE_DELAY_MS = 4000;

export class EarlyBirdSimClient implements EarlyBirdClient {
  private _orders = new Map<string, Order>();
  /** tokenId → earliest ms at which sells can be placed (simulates on-chain balance delay). */
  private _balanceReadyAt = new Map<string, number>();

  constructor(private getBook: (tokenId: string) => BookSnapshot) {}

  async init(): Promise<void> {}

  async postMultipleOrders(
    orders: MultiOrderRequest[],
  ): Promise<PlacedOrder[]> {
    await simulateDelay();
    return orders.map((req) => {
      if (req.action === "sell") {
        const readyAt = this._balanceReadyAt.get(req.tokenId) ?? 0;
        if (Date.now() < readyAt) {
          return {
            orderId: "",
            status: "",
            success: true,
            errorMsg:
              "not enough balance / allowance: the balance is not enough -> balance: 0, order amount: 6000000",
          };
        }
      }

      // FOK: fill immediately or reject — matches real CLOB behavior
      if (req.orderType === "FOK") {
        const book = this.getBook(req.tokenId);
        if (isSimFilled(req, book)) {
          const orderId = crypto.randomUUID();
          this._orders.set(orderId, {
            id: orderId,
            tokenId: req.tokenId,
            action: req.action,
            price: req.price,
            shares: req.shares,
            actualShares: req.shares,
            status: "filled",
          });
          if (req.action === "buy") {
            this._balanceReadyAt.set(
              req.tokenId,
              Date.now() + SIM_BALANCE_DELAY_MS,
            );
          }
          return { orderId, status: "matched", success: true, errorMsg: "" };
        }
        return {
          orderId: "",
          status: "",
          success: true,
          errorMsg:
            "order couldn't be fully filled. FOK orders are fully filled or killed.",
        };
      }

      // GTC: order rests on the book until filled
      const orderId = crypto.randomUUID();
      const order: Order = {
        id: orderId,
        tokenId: req.tokenId,
        action: req.action,
        price: req.price,
        shares: req.shares,
        actualShares: req.shares,
        status: "live",
      };
      this._orders.set(orderId, order);
      return { orderId, status: "live", success: true, errorMsg: "" };
    });
  }

  async getOpenOrderIds(_conditionId: string): Promise<Set<string>> {
    await simulateDelay();
    const openIds = new Set<string>();
    for (const order of this._orders.values()) {
      if (order.status !== "live") continue;
      const book = this.getBook(order.tokenId);
      const matchedShares = simMatchedShares(order, book);
      if (matchedShares + 1e-9 >= order.shares) {
        this._orders.set(order.id, {
          ...order,
          status: "filled",
          actualShares: order.shares,
        });
        if (order.action === "buy") {
          this._balanceReadyAt.set(
            order.tokenId,
            Date.now() + SIM_BALANCE_DELAY_MS,
          );
        }
      } else {
        openIds.add(order.id);
      }
    }
    return openIds;
  }

  async getOrderById(orderId: string): Promise<Order | null> {
    await simulateDelay();
    const order = this._orders.get(orderId);
    if (!order) return null;

    if (order.status === "live") {
      const book = this.getBook(order.tokenId);
      const matchedShares = simMatchedShares(order, book);
      if (matchedShares + 1e-9 >= order.shares) {
        const updated: Order = {
          ...order,
          status: "filled",
          actualShares: order.shares,
        };
        this._orders.set(orderId, updated);
        if (order.action === "buy") {
          this._balanceReadyAt.set(
            order.tokenId,
            Date.now() + SIM_BALANCE_DELAY_MS,
          );
        }
        return updated;
      }
      return {
        ...order,
        actualShares: matchedShares,
      };
    }

    return {
      ...order,
      actualShares: order.shares,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await simulateDelay();
    this._orders.delete(orderId);
  }

  async cancelOrders(orderIds: string[]): Promise<CancelOrderResponse> {
    await simulateDelay();
    const canceled: string[] = [];
    const not_canceled: Record<string, string> = {};
    for (const id of orderIds) {
      if (this._orders.has(id)) {
        this._orders.delete(id);
        canceled.push(id);
      } else {
        not_canceled[id] = "NOT_FOUND";
      }
    }
    return { canceled, not_canceled };
  }

  /** Re-insert a persisted order (for startup recovery). */
  restoreOrder(order: Order): void {
    this._orders.set(order.id, { ...order, status: "live" });
  }

  async getUSDCBalance(): Promise<number> {
    return Infinity;
  }

  async getAvailableShares(_tokenId: string): Promise<number> {
    return Infinity;
  }

  async updateUSDCBalance(): Promise<void> {}

  async updateAvailableShares(_tokenId: string): Promise<void> {}

  async redeemPositions(
    _conditionId: string,
    _silent?: boolean,
  ): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Real Polymarket CLOB client
// ---------------------------------------------------------------------------

function mapStatus(status: string): Order["status"] {
  switch (status.toLowerCase()) {
    case "matched":
      return "filled";
    case "live":
    case "unmatched":
      return "live";
    case "delayed":
      return "delayed";
    default:
      return "cancelled";
  }
}

export class PolymarketEarlyBirdClient implements EarlyBirdClient {
  clob!: ClobClient;
  private readonly _host = "https://clob.polymarket.com";
  private readonly _signer: Wallet;
  private readonly _funder: string | undefined;
  private readonly _builderConfig: BuilderConfig;

  constructor() {
    const privateKey = Env.get("PRIVATE_KEY");
    this._funder = Env.get("POLY_FUNDER_ADDRESS") || undefined;

    if (!privateKey?.startsWith("0x")) {
      throw new Error("PRIVATE_KEY env var must be set (0x-prefixed)");
    }

    const builderKey = Env.get("BUILDER_KEY");
    const builderSecret = Env.get("BUILDER_SECRET");
    const builderPassphrase = Env.get("BUILDER_PASSPHRASE");

    if (!builderKey || !builderSecret || !builderPassphrase) {
      throw new Error(
        "BUILDER_KEY, BUILDER_SECRET, BUILDER_PASSPHRASE env vars must be set",
      );
    }

    this._builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: builderKey,
        secret: builderSecret,
        passphrase: builderPassphrase,
      },
    });

    this._signer = new Wallet(privateKey);
  }

  async init(): Promise<void> {
    const creds = await new ClobClient(
      this._host,
      137,
      this._signer,
    ).createOrDeriveApiKey();
    this.clob = new ClobClient(
      this._host,
      137,
      this._signer,
      creds,
      1, // Magic/Email login
      this._funder,
    );
  }

  // Optimized way of posting multiple orders without making many API calls
  async postMultipleOrders(
    orders: MultiOrderRequest[],
  ): Promise<PlacedOrder[]> {
    // Sign all orders in parallel, passing pre-fetched options to skip network calls
    // This is fully offline
    const signed = await Promise.all(
      orders.map((req) => {
        const userOrder: UserOrder = {
          tokenID: req.tokenId,
          price: req.price,
          size: req.shares,
          side: req.action === "buy" ? Side.BUY : Side.SELL,
          feeRateBps: req.feeRateBps,
        };
        return this.clob.orderBuilder.buildOrder(userOrder, {
          tickSize: req.tickSize as TickSize,
          negRisk: req.negRisk,
        });
      }),
    );

    const resp: Array<{
      orderID: string;
      status: string;
      success: boolean;
      errorMsg: string;
    }> = await this.clob.postOrders(
      signed.map((order, i) => ({
        order,
        orderType:
          orders[i]!.orderType === "FOK"
            ? ClobOrderType.FOK
            : ClobOrderType.GTC,
      })),
    );
    return resp.map((r) => ({
      orderId: r.orderID,
      status: r.status,
      success: r.success,
      errorMsg: r.errorMsg,
    }));
  }

  async getOpenOrderIds(conditionId: string): Promise<Set<string>> {
    const orders = await this.clob.getOpenOrders({ market: conditionId });
    return new Set(orders.map((o) => o.id));
  }

  async getOrderById(orderId: string): Promise<Order | null> {
    try {
      const o = await this.clob.getOrder(orderId);
      if (!o || !o.id) return null;
      return {
        id: o.id,
        tokenId: o.asset_id,
        action: o.side === "BUY" ? "buy" : "sell",
        price: parseFloat(o.price),
        shares: parseFloat(o.original_size),
        actualShares: parseFloat(o.size_matched),
        status: mapStatus(o.status),
      };
    } catch {
      return null;
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.clob.cancelOrder({ orderID: orderId });
  }

  async cancelOrders(orderIds: string[]): Promise<CancelOrderResponse> {
    if (orderIds.length === 0) return { canceled: [], not_canceled: {} };
    const resp = await this.clob.cancelOrders(orderIds);
    return resp as CancelOrderResponse;
  }

  /** No-op for real client — orders already exist on the exchange. */
  restoreOrder(_order: Order): void {}

  async getUSDCBalance(): Promise<number> {
    const resp = await this.clob.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    if (!resp || typeof resp === "string") return 0;
    return Number(resp.balance ?? 0) / 1e6;
  }

  async getAvailableShares(tokenId: string): Promise<number> {
    const resp = await this.clob.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    if (!resp || typeof resp === "string") return 0;
    return Number(resp.balance ?? 0) / 1e6;
  }

  async updateUSDCBalance(): Promise<void> {
    return await this.clob.updateBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
  }

  async updateAvailableShares(tokenId: string): Promise<void> {
    return await this.clob.updateBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
  }

  async redeemPositions(conditionId: string, silent = false): Promise<void> {
    const account = privateKeyToAccount(
      this._signer.privateKey as `0x${string}`,
    );
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http("https://polygon-bor-rpc.publicnode.com"),
    });
    const relay = new RelayClient(
      RELAYER_URL,
      137,
      walletClient,
      this._builderConfig,
      RelayerTxType.PROXY,
    );
    const data = encodeFunctionData({
      abi: CTF_REDEEM_ABI,
      functionName: "redeemPositions",
      args: [USDC_ADDRESS, zeroHash, conditionId as `0x${string}`, [1n, 2n]],
    });

    const origLog = console.log;
    const origInfo = console.info;
    if (silent) {
      console.log = () => {};
      console.info = () => {};
    }
    try {
      const response = await relay.execute(
        [{ to: CTF_ADDRESS, data, value: "0" }],
        "redeem positions",
      );
      const result = await response.wait();
      if (!result)
        throw new Error(`Redemption relay failed for ${conditionId}`);
    } finally {
      if (silent) {
        console.log = origLog;
        console.info = origInfo;
      }
    }
  }
}
