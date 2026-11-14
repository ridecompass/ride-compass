// 費用のレンズ（総合と費用の軸ごと。どれも1kmあたりの代償の秒）の段の塗りと、値の書き方。地図の道・ルートの線・候補の帯・
// 道の窓が同じ段と同じ書き方にする。
import type { MapTheme } from "@/lib/mapTheme";
import type { MapPaintDeclaration } from "@/lib/mapDisplay/valueScale";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

/** レンズの値の単位。段の境目も凡例の範囲もこの単位で書く。 */
export const LENS_SECONDS_UNIT = routeGenerateConfig.lens_unit;
/** レンズの量の名前。レンズを述べる画面の文が差し込む。 */
export const LENS_QUANTITY_LABEL = routeGenerateConfig.lens_quantity_label;

/** 塗りを決めるレンズの見せ方（`GET /api/cost-axes`の総合のレンズと軸の行が持つ段）。 */
export interface CostLensBands {
  readonly lens: { readonly thresholds: readonly number[]; readonly band_labels: readonly string[] };
}

/** レンズの段の塗り。 */
export function costLensPaint(presentation: CostLensBands, ground: MapTheme): MapPaintDeclaration {
  return {
    ground,
    boundaries: presentation.lens.thresholds,
    unit: LENS_SECONDS_UNIT,
    bandLabels: presentation.lens.band_labels,
  };
}

/** レンズの値と事実の数の書き方（整数はそのまま、ほかは小数1桁）。 */
export function formatLensNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
