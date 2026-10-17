import type { RoadAvoidanceOverride } from "@/types/route";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

// 道のレイヤの凡例の行ごとの避け方。**行・段・既定はbackendが正**で、生成物
// （route-generate-config.json）から受け取る——backendは鍵の集合の完全一致を要求するため、
// 手書きで複製すると行が1つ増えた瞬間にすべてのルート生成が422になる。
export const DEFAULT_ROAD_AVOIDANCE: RoadAvoidanceOverride = Object.fromEntries(
  routeGenerateConfig.road_avoidance.rows.map(({ key, default: level }) => [
    key,
    level as RoadAvoidanceOverride[string],
  ]),
);
