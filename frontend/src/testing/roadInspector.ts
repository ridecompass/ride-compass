// 押した道の詳細（`features/map/MapView/RoadInspectorPopup.tsx`）へ渡す走行の条件と、道の窓の応答（backend
// `POST /api/region/road-inspector`）を組み立てる道具。
import { onBackend, serveCostAxisCatalog } from "@/testing/backendServer";
import { TWO_COST_AXES } from "@/testing/costAxes";
import type { RoadInspection } from "@/features/map/regionApi";
import { STANDARD_COST_PREFERENCE } from "@/lib/costPreference";
import type { CostAxisCatalogResponse } from "@/types/route";

type LensInspection = RoadInspection["lens"];
type LensDirection = NonNullable<LensInspection["along"]>;

/** 道の窓の応答を返す。負担の名前は費用の軸の一覧から引くので、一覧（既定は`TWO_COST_AXES`）も返す。 */
export function serveInspector(result: RoadInspection, costAxes: CostAxisCatalogResponse = TWO_COST_AXES) {
  serveCostAxisCatalog(costAxes);
  return onBackend("POST", "/api/region/road-inspector", () => Response.json(result));
}

/** 地図がいつも渡す走行の条件（押した点のタイル込み）と利用者の値（標準）。 */
export const RIDE = {
  costPreference: STANDARD_COST_PREFERENCE,
  conditions: {
    bearingDeg: 0,
    at: new Date("2026-09-24T00:00:00Z"),
    speedKmh: 20,
    z: 14,
    x: 1,
    y: 2,
  },
};

/** 1つの向きの負担。軸ごとの秒と元の事実は、見たい呼び出し側が書く。 */
export function lensDirection(totalSeconds: number, overrides: Partial<LensDirection> = {}): LensDirection {
  return { total_seconds: totalSeconds, axes: [], facts: {}, ...overrides };
}

/** 道の向きを塗る道の応答。レンズの値は一部だけを上書きできる。 */
export function inspectorResult(lens: Partial<LensInspection> = {}): RoadInspection {
  return {
    highway: "residential",
    tags: { lit: "yes", name: "明治通り" },
    lens: { painted: "along", along: lensDirection(12), against: lensDirection(3), ...lens },
  };
}
