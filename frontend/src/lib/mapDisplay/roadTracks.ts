/** 道の線の層（軸カタログの`road_classes.map_layers`）の凡例の行（区分・その他／該当なし・データなし）。地図の線・地図の凡例・
 * 道のりのグラフの帯が同じ行を読む——別々に持つと、同じ道が地図と帯で違う色・呼び名になる。
 * 層・区分・色・呼び名は配られた層が決め、ここは受け取って行に並べるだけ。 */
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import type { RoadMapLayerView } from "@/types/route";

import { NO_DATA_LEGEND_BAND } from "@/lib/mapDisplay/mapColorLegend";

/** 凡例の「その他」（どの区分にも入らない道）の鍵。 */
export const ROAD_OTHER_KEY = "other";

export type RoadTrackRow = {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly color: string;
  readonly isFallback?: boolean;
};

/** 区分に入らない道の行。データなしを分けない層では、区分の外の道は全部「該当しない」ことそのものなので呼び方を変える。 */
function otherRow(layer: RoadMapLayerView): RoadTrackRow {
  const row = layer.has_no_data ? mapDisplay.legendSharedRows.other : mapDisplay.legendSharedRows.notApplicable;
  return { key: ROAD_OTHER_KEY, ...row, color: palette.semantic.no_data };
}

/** どの区分にも入らない行（その他・該当なし・データなし）か。 */
export function isUnclassifiedRow(row: RoadTrackRow): boolean {
  return row.key === ROAD_OTHER_KEY || row.isFallback === true;
}

/** 凡例の行の並び。区分、その他（該当なし）、データなしを分ける層ではデータなし。 */
export function roadTrackRows(layer: RoadMapLayerView): readonly RoadTrackRow[] {
  return [...layer.classes, otherRow(layer), ...(layer.has_no_data ? [NO_DATA_LEGEND_BAND] : [])];
}

/** 層の値`classKey`（区分の鍵か「データなし」）が入る凡例の行。nullと知らない鍵は、区分の外の道の行（その他・該当なし）。 */
export function roadTrackRowOf(layer: RoadMapLayerView, classKey: string | null): RoadTrackRow {
  if (classKey === mapDisplay.road.noDataValue) return NO_DATA_LEGEND_BAND;
  return layer.classes.find((candidate) => candidate.key === classKey) ?? otherRow(layer);
}
