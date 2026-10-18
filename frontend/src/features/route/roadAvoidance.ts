import type { RoadAvoidanceOverride } from "@/types/route";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

// 道のレイヤの凡例の行ごとの避け方。**行・段・既定はbackendが正**で、生成物
// （route-generate-config.json）から受け取る——backendは鍵の集合の完全一致を要求するため、
// 手書きで複製すると行が1つ増えた瞬間にすべてのルート生成が422になる。

export type AvoidanceLevel = RoadAvoidanceOverride[string];

/** 避け方の段（弱い順）と画面に出す名前。 */
export const AVOIDANCE_LEVELS = routeGenerateConfig.road_avoidance.levels as readonly {
  key: AvoidanceLevel;
  label: string;
}[];

/** 避け方を選べる行。並びは地図の道のレイヤと凡例の並び。 */
export const AVOIDABLE_ROWS = routeGenerateConfig.road_avoidance.rows as readonly {
  key: string;
  layer: string;
  layer_label: string;
  label: string;
  description: string;
  default: AvoidanceLevel;
  /** 分ける前の行の鍵。前の鍵で保存した段を、分けてできた行へ引き継ぐ。 */
  former_key: string | null;
}[];

export const DEFAULT_ROAD_AVOIDANCE: RoadAvoidanceOverride = Object.fromEntries(
  AVOIDABLE_ROWS.map(({ key, default: level }) => [key, level]),
);

function isAvoidanceLevel(value: unknown): value is AvoidanceLevel {
  return AVOIDANCE_LEVELS.some(({ key }) => key === value);
}

/** 保存した避け方を今の行へ揃える。今の行に無い鍵は落とし、分けてできた行は分ける前の行の段を引き継ぎ、
 * どちらも無い行・今は無い段の行は既定の段にする。 */
export function syncRoadAvoidance(stored: unknown): RoadAvoidanceOverride {
  const levels = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  return Object.fromEntries(
    AVOIDABLE_ROWS.map(({ key, default: level, former_key: formerKey }) => {
      const kept = [levels[key], formerKey === null ? undefined : levels[formerKey]].find(isAvoidanceLevel);
      return [key, kept ?? level];
    }),
  );
}
