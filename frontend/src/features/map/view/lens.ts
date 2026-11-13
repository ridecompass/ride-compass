/** レンズ（地図を何で塗るか）の1つの値から、地図と`LensControl`へ渡すものを導く。
 *
 * 全道路の塗りもルート線の色分けも同じ`lens`から導き、レンズの種類ごとの分岐は持たない。
 */
import type { MapLens } from "@/lib/mapDisplay/mapLens";
import {
  NO_DATA_LEGEND_BAND,
  UNDETERMINED_LEGEND_BAND,
  type MapColorLegendBand,
} from "@/lib/mapDisplay/mapColorLegend";
import { valueBands } from "@/lib/mapDisplay/valueScale";
import type { LegendEntry } from "@/lib/mapDisplay/legendFilter";
import type { LensId } from "@/lib/mapDisplay/routeStyleModes";
import type { MapCatalog } from "@/features/map/mapCatalog";

/** レンズの凡例。地図がいま塗っているものの凡例だけを出す——塗っていない間に出すと、
 * 地図のどこにも無い色見本の表になる。ルート確定後はルート線のモードの凡例。 */
export function lensLegend(
  lens: LensId,
  hasDetail: boolean,
  catalog: Pick<MapCatalog, "routeStyleModes" | "lenses">,
): readonly LegendEntry[] {
  if (hasDetail) return catalog.routeStyleModes.find((mode) => mode.id === lens)?.legend ?? [];
  const painted = catalog.lenses.find((candidate) => candidate.lensId === lens);
  return painted === undefined ? [] : mapLensLegend(painted);
}

/** 地図上の色分け凡例。地図の線と同じ配色・しきい値から段階ラベル付きの凡例を組み立てる。
 * 末尾の「データなし」は値を受け取れなかった道路の受け皿で、ルート確定後のルート線の凡例（`routeStyleModes.ts`）と
 * 段階の並び・キーを揃える。「向きで決まらない」は、走行方位に直角に近い道（ルートの線は実際に走る向きで決まるので持たない）。 */
function mapLensLegend(lens: MapLens): MapColorLegendBand[] {
  const bands = valueBands(lens.display).map(({ key, label, color }) => ({ key, label, color }));
  return [...bands, UNDETERMINED_LEGEND_BAND, NO_DATA_LEGEND_BAND];
}
