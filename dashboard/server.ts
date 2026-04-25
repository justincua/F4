import { existsSync, readFileSync } from "fs";
import { readBotControl, writeBotControl } from "../engine/bot-control.ts";
import type { DashboardState } from "../engine/dashboard-state.ts";

const PORT = Number(process.env.PORT ?? process.env.DASHBOARD_PORT ?? 3000);
const HOSTNAME = process.env.BIND_HOST ?? process.env.HOST ?? "0.0.0.0";
const STATE_PATH = "state/dashboard.json";
const HTML_PATH = "dashboard/index.html";

const IS_RAILWAY =
  !!process.env.RAILWAY_ENVIRONMENT ||
  !!process.env.RAILWAY_PROJECT_ID ||
  !!process.env.RAILWAY_SERVICE_ID;

function boolEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function parseRounds(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().toLowerCase();
  if (
    text === "" ||
    text === "unlimited" ||
    text === "infinite" ||
    text === "inf" ||
    text === "null" ||
    text === "none" ||
    text === "-1"
  ) {
    return null;
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function roundsText(rounds: number | null): string {
  return rounds === null ? "unlimited" : String(rounds);
}

const AUTO_START_BOT = boolEnv(process.env.AUTO_START_BOT, IS_RAILWAY);
const AUTO_RESTART_BOT = boolEnv(process.env.AUTO_RESTART_BOT, AUTO_START_BOT);
const AUTO_RESTART_MAX = Math.max(0, Number(process.env.AUTO_RESTART_MAX ?? 3));
const BOT_RESTART_DELAY_MS = Math.max(
  1000,
  Number(process.env.BOT_RESTART_DELAY_MS ?? 5000),
);

let botProcess: any = null;
let autoRestartTimer: any = null;
let autoRestartCount = 0;
let lastControllerMessage = "Dashboard sẵn sàng";

function isBotProcessRunning(): boolean {
  return !!botProcess && botProcess.exitCode === null;
}

function emptyState(): DashboardState {
  const control = readBotControl();
  return {
    startedAt: null,
    strategy: process.env.DASHBOARD_DEFAULT_STRATEGY ?? "gap-six-layer-arb",
    mode: "SIM",
    asset: process.env.MARKET_ASSET?.toUpperCase() ?? "BTC",
    marketWindow: process.env.MARKET_WINDOW ?? "5m",
    initialBalance: Number(process.env.WALLET_BALANCE ?? 0),
    balance: Number(process.env.WALLET_BALANCE ?? 0),
    available: Number(process.env.WALLET_BALANCE ?? 0),
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
    status: AUTO_START_BOT
      ? "Railway auto-start đang bật. Bot sẽ tự chạy sau khi server khởi động."
      : "Chưa có dữ liệu. Hãy bấm START để chạy bot.",
    control: {
      paused: control.paused,
      process: isBotProcessRunning() ? "running" : "stopped",
      lastCommand: control.lastCommand,
      updatedAt: control.updatedAt,
    },
  };
}

function loadState(): DashboardState | Record<string, unknown> {
  try {
    const state = existsSync(STATE_PATH)
      ? (JSON.parse(readFileSync(STATE_PATH, "utf8")) as DashboardState)
      : emptyState();
    const control = readBotControl();
    return {
      ...state,
      controllerMessage: lastControllerMessage,
      control: {
        ...state.control,
        paused: control.paused,
        process: isBotProcessRunning() ? "running" : (state.control?.process ?? "stopped"),
        lastCommand: control.lastCommand,
        updatedAt: control.updatedAt,
      },
    };
  } catch (e) {
    return { error: String(e) };
  }
}

function loadHtml(): string {
  return readFileSync(HTML_PATH, "utf8")
    .replaceAll("__PORT__", String(PORT))
    .replaceAll("http://localhost:" + String(PORT), "Railway public URL");
}

async function readJson(req: Request): Promise<Record<string, any>> {
  try {
    return (await req.json()) as Record<string, any>;
  } catch {
    return {};
  }
}

function makeAutoStartParams(): Record<string, any> {
  return {
    strategy: process.env.DASHBOARD_DEFAULT_STRATEGY ?? "gap-six-layer-arb",
    rounds:
      process.env.DASHBOARD_AUTO_ROUNDS ??
      process.env.DASHBOARD_DEFAULT_ROUNDS ??
      "unlimited",
    slotOffset: process.env.DASHBOARD_DEFAULT_SLOT_OFFSET ?? 0,
    prod: boolEnv(process.env.DASHBOARD_AUTO_PROD ?? process.env.PROD, false),
    alwaysLog: true,
  };
}

function scheduleAutoStart(reason: string, delayMs = BOT_RESTART_DELAY_MS) {
  if (!AUTO_START_BOT && reason !== "manual") return;
  if (autoRestartTimer || isBotProcessRunning()) return;

  autoRestartTimer = setTimeout(() => {
    autoRestartTimer = null;
    const control = readBotControl();

    if (control.paused || control.stopRequested) {
      lastControllerMessage = "Auto-start bị bỏ qua vì bot đang PAUSE/STOP.";
      console.log(`[auto] skip: ${lastControllerMessage}`);
      return;
    }

    const result = startBot(makeAutoStartParams(), "auto");
    console.log(`[auto] ${reason}: ${JSON.stringify(result)}`);
  }, delayMs);
}

function startBot(params: Record<string, any>, source: "manual" | "auto" = "manual") {
  if (autoRestartTimer) {
    clearTimeout(autoRestartTimer);
    autoRestartTimer = null;
  }

  if (isBotProcessRunning()) {
    return { ok: false, error: "BOT_ALREADY_RUNNING", message: "Bot đang chạy rồi." };
  }

  const strategy = String(params.strategy || process.env.DASHBOARD_DEFAULT_STRATEGY || "gap-six-layer-arb");
  const rounds = parseRounds(
    params.rounds ??
      process.env.DASHBOARD_DEFAULT_ROUNDS ??
      (source === "auto" ? "unlimited" : 20),
  );
  const slotOffset = Math.max(
    0,
    Number(params.slotOffset ?? process.env.DASHBOARD_DEFAULT_SLOT_OFFSET ?? 0),
  );
  const prod = params.prod === true || params.prod === "true";
  const alwaysLog = params.alwaysLog !== false;

  if (prod && process.env.DASHBOARD_ALLOW_PROD_START !== "true") {
    return {
      ok: false,
      error: "PROD_START_LOCKED",
      message:
        "Production đang bị khóa. Set DASHBOARD_ALLOW_PROD_START=true nếu thật sự muốn dashboard chạy tiền thật.",
    };
  }

  writeBotControl({
    paused: false,
    stopRequested: false,
    lastCommand: "start",
    message:
      source === "auto"
        ? "Auto-start từ Railway/Dashboard server"
        : "Start từ CuaX Trader",
  });

  const args = ["run", "index.ts", "--strategy", strategy, "--slot-offset", String(slotOffset)];
  if (rounds !== null) args.push("--rounds", String(rounds));
  if (alwaysLog) args.push("--always-log");
  if (prod) args.push("--prod");

  const env = {
    ...process.env,
    ...(prod ? { FORCE_PROD: "true", PROD: "true" } : {}),
  };

  botProcess = Bun.spawn(["bun", ...args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
    env,
  });

  lastControllerMessage = `Đã START bot realtime (${source}): strategy=${strategy}, rounds=${roundsText(rounds)}, slotOffset=${slotOffset}, mode=${prod ? "PROD" : "SIM"}, shares=${process.env.TRADE_SHARES ?? process.env.ORDER_SHARES ?? process.env.SHARES ?? "10"}`;

  botProcess.exited.then((code: number) => {
    botProcess = null;
    lastControllerMessage = `Bot đã thoát với code ${code}`;
    writeBotControl({ lastCommand: "idle", message: lastControllerMessage });
    console.log(`[bot] exited with code ${code}`);

    const control = readBotControl();
    const canRestart =
      AUTO_RESTART_BOT &&
      code !== 0 &&
      !control.paused &&
      !control.stopRequested &&
      autoRestartCount < AUTO_RESTART_MAX;

    if (canRestart) {
      autoRestartCount++;
      lastControllerMessage = `Bot crash code ${code}. Auto-restart lần ${autoRestartCount}/${AUTO_RESTART_MAX} sau ${Math.round(BOT_RESTART_DELAY_MS / 1000)}s.`;
      scheduleAutoStart(lastControllerMessage);
    } else if (code === 0) {
      autoRestartCount = 0;
    }
  });

  return { ok: true, message: lastControllerMessage };
}

function pauseBot() {
  if (autoRestartTimer) {
    clearTimeout(autoRestartTimer);
    autoRestartTimer = null;
  }

  const control = writeBotControl({
    paused: true,
    lastCommand: "pause",
    message: "Pause từ CuaX Trader",
  });
  lastControllerMessage = "Đã PAUSE bot. Bot sẽ không tạo market mới và sẽ dừng lifecycle đang chạy an toàn.";
  return { ok: true, control, message: lastControllerMessage };
}

function resumeBot() {
  const control = writeBotControl({
    paused: false,
    stopRequested: false,
    lastCommand: "resume",
    message: "Resume từ CuaX Trader",
  });
  lastControllerMessage = "Đã RESUME bot.";
  return { ok: true, control, message: lastControllerMessage };
}

function stopBot() {
  if (autoRestartTimer) {
    clearTimeout(autoRestartTimer);
    autoRestartTimer = null;
  }

  const control = writeBotControl({
    paused: true,
    stopRequested: true,
    lastCommand: "stop",
    message: "Stop từ CuaX Trader",
  });

  lastControllerMessage = "Đã gửi lệnh STOP. Bot sẽ dừng graceful.";

  if (isBotProcessRunning()) {
    setTimeout(() => {
      if (isBotProcessRunning()) {
        try {
          botProcess.kill("SIGTERM");
          lastControllerMessage = "Đã gửi SIGTERM cho bot.";
        } catch (e) {
          lastControllerMessage = `Không thể kill bot: ${String(e)}`;
        }
      }
    }, 4000);
  }

  return { ok: true, control, message: lastControllerMessage };
}

const server = Bun.serve({
  hostname: HOSTNAME,
  port: PORT,
  async fetch(req: Request) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "cua-gap-six-layer-arb-dashboard",
        botRunning: isBotProcessRunning(),
        autoStart: AUTO_START_BOT,
        railway: IS_RAILWAY,
        time: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/state") return Response.json(loadState());
    if (url.pathname === "/api/control/start" && req.method === "POST") {
      return Response.json(startBot(await readJson(req)));
    }
    if (url.pathname === "/api/control/pause" && req.method === "POST") return Response.json(pauseBot());
    if (url.pathname === "/api/control/resume" && req.method === "POST") return Response.json(resumeBot());
    if (url.pathname === "/api/control/stop" && req.method === "POST") return Response.json(stopBot());
    if (url.pathname === "/") {
      return new Response(loadHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(
  `CuaX Trader chạy tại http://${HOSTNAME}:${server.port} | Railway=${IS_RAILWAY} | autoStart=${AUTO_START_BOT}`,
);

if (AUTO_START_BOT) {
  scheduleAutoStart("initial deploy", Number(process.env.AUTO_START_DELAY_MS ?? 8000));
}
