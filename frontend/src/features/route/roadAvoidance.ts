import type { RoadAvoidanceOverride, RoadAvoidanceView } from "@/types/route";

// 道の区分の行ごとの避け方。**行・段・既定は軸カタログ（`road_classes.avoidance`）が配る**。端末に覚えるのは利用者が選んだ段
// だけで、要求へもそのまま送る——足りない行の既定の段・前の鍵の読み替えはbackendが今の行へ揃える（軸カタログが届く前に送っても、
// 選んだ段が落ちない）。

export type AvoidanceLevel = RoadAvoidanceOverride[string];
export type AvoidanceRow = RoadAvoidanceView["rows"][number];

// 鍵はbackendの段の型そのもので、段が増減すれば型検査が落ちる。
const LEVEL_KEYS: Readonly<Record<AvoidanceLevel, true>> = { pass: true, avoid: true, exclude: true };

function isAvoidanceLevel(value: unknown): value is AvoidanceLevel {
  return typeof value === "string" && Object.hasOwn(LEVEL_KEYS, value);
}

/** 保存した避け方のうち、段として読める鍵だけを残す（今の行に無い鍵も残す。前の鍵として読まれうる）。 */
export function readRoadAvoidance(stored: unknown): RoadAvoidanceOverride {
  if (typeof stored !== "object" || stored === null) return {};
  return Object.fromEntries(Object.entries(stored).filter((entry) => isAvoidanceLevel(entry[1])));
}

/** 画面に出す行の段。今の鍵に段が無ければ前の鍵の段のうち強い方を、どちらも無ければ既定の段を取る（backendが要求を揃える
 * のと同じ読み方で、画面と経路の段を食い違わせない）。 */
export function avoidanceLevelOf(
  row: AvoidanceRow,
  chosen: RoadAvoidanceOverride,
  levels: RoadAvoidanceView["levels"],
): AvoidanceLevel {
  const current = chosen[row.key];
  if (current !== undefined) return current;
  const strength = (level: AvoidanceLevel) => levels.findIndex(({ key }) => key === level);
  const formers = row.former_keys.flatMap((key) => (chosen[key] === undefined ? [] : [chosen[key]]));
  if (formers.length === 0) return row.default;
  return formers.reduce((strongest, level) => (strength(level) > strength(strongest) ? level : strongest));
}
