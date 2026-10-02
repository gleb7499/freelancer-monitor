import type { Env, Order } from "./types";
import type { ScoreResult } from "./types";
import { getConfig } from "./config";

// Заглушка авто-отклика. По умолчанию выключена (AUTOBID_ENABLED=false) —
// worker только мониторит, человек откликается вручную.
export async function placeBid(
  env: Env,
  order: Order,
  score: ScoreResult,
  bidText: string | null,
): Promise<void> {
  if (!getConfig(env).autobidEnabled) {
    console.log("autobid.skipped", { id: order.id });
    return;
  }
  console.log("autobid.not-implemented", { id: order.id, bid: score.bid_amount, bidText: bidText !== null });
}
