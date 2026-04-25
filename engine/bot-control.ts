import { mkdirSync, readFileSync, writeFileSync } from "fs";

export type BotControl = {
  paused: boolean;
  stopRequested: boolean;
  lastCommand: "idle" | "start" | "pause" | "resume" | "stop";
  updatedAt: string;
  message?: string;
};

const CONTROL_PATH = "state/bot-control.json";

const DEFAULT_CONTROL: BotControl = {
  paused: false,
  stopRequested: false,
  lastCommand: "idle",
  updatedAt: new Date(0).toISOString(),
};

export function readBotControl(): BotControl {
  try {
    const raw = readFileSync(CONTROL_PATH, "utf8");
    return { ...DEFAULT_CONTROL, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONTROL, updatedAt: new Date().toISOString() };
  }
}

export function writeBotControl(patch: Partial<BotControl>): BotControl {
  mkdirSync("state", { recursive: true });
  const next: BotControl = {
    ...readBotControl(),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(CONTROL_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function clearStopRequest(): BotControl {
  return writeBotControl({ stopRequested: false });
}
