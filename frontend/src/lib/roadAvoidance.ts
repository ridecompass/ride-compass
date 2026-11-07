import type { RoadAvoidanceOverride, RoadAvoidanceView } from "@/types/route";

// 道の区分の行ごとの避け方。**行・段・既定は画面の設定（`road_classes.avoidance`）が配る**。端末に覚えるのは利用者が選んだ段
// だけで、要求へもそのまま送る——足りない行の既定の段はbackendが今の行へ揃える（画面の設定が届く前に送っても、選んだ段が
// 落ちない）。

export type AvoidanceLevel = RoadAvoidanceOverride[string];
export type AvoidanceRow = RoadAvoidanceView["rows"][number];

/** 画面に出す行の段。選んでいなければ既定の段。 */
export function avoidanceLevelOf(row: AvoidanceRow, chosen: RoadAvoidanceOverride): AvoidanceLevel {
  return chosen[row.key] ?? row.default;
}
