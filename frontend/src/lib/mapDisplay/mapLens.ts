// 地図のレンズ（総合と費用の軸ごと。どれも道を1kmあたりの代償の秒で塗る）。`features/map/costLens.ts`が費用の軸の一覧
// （`GET /api/cost-axes`）から作る。

import type { MapPaintDeclaration } from "./valueScale";
import type { components } from "@/types/generated/api";

type MapLensFormula = components["schemas"]["CostAxisCatalogResponse"]["map_lens"];

/** 地図の式の木が読む走る条件の名前。 */
export type WayValueCondition = MapLensFormula["material_conditions"][number];

export interface MapLens {
  /** 総合（`TOTAL_LENS_ID`）か費用の軸のid。 */
  lensId: string;
  label: string;
  description: string;
  iconId: string;
  /** 値が変わる走る条件（材料の要求に載せる条件と、式の木が辿る向きを選ぶ走行方位）。 */
  conditions: readonly WayValueCondition[];
  /** `conditions`のうち、道ごとの材料の要求（`/api/region/lens/{lens_id}/...`）へ載せるもの。ほかは式の木が読む。 */
  materialConditions: readonly WayValueCondition[];
  /** 地図に塗る段。 */
  display: MapPaintDeclaration;
  /** 道の値を求める式の木（辿る向きを走行方位で選ぶ）。 */
  formula: MapLensFormula["formula"];
}
