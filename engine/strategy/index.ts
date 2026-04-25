import type { Strategy } from "./types.ts";
import { simulationStrategy } from "./simulation.ts";
import { lateEntry } from "./late-entry.ts";
import { sixLayerArb } from "./six-layer-arb.ts";
import { gapSixLayerArb } from "./gap-six-layer-arb.ts";

export const strategies: Record<string, Strategy> = {
  "simulation": simulationStrategy,
  "late-entry": lateEntry,
  "six-layer-arb": sixLayerArb,
  "gap-six-layer-arb": gapSixLayerArb,
};

export const DEFAULT_STRATEGY = "gap-six-layer-arb";

export type { Strategy, StrategyContext } from "./types.ts";
