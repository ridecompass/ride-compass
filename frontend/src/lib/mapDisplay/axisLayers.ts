// 軸カタログ（`GET /api/axis-catalog`）の軸を、地図が読む形（道ごとの値で塗る軸）へ移す。軸の共通の項目は
// `catalogAxis.ts`が行から移し、ここは地図の表示の項目だけを足す。
//
// 軸の地図の塗り方は`domain/map_paint.py: map_paint`が軸スタジオの公開状態から都度作り、
// **ビルド時の写しは持たない**——写しを持つと、API障害時に古い軸で地図が描かれ、伝播の失敗が
// 見えなくなる。取得できるまでは軸0件で描く（`hooks/useAxisCatalog.ts`）。軸は軸スタジオで公開すれば、
// 再デプロイなしに地図のレイヤーとして現れる。

import { mapPaintDeclarationOf, type MapPaintDeclaration } from "./valueScale";
import { catalogAxisFromEntry, type CatalogAxis, type WayValueCondition } from "@/lib/catalogAxis";
import type { components } from "@/types/generated/api";
import type { AxisCatalogEntry } from "@/types/route";

/** 道ごとの値（軸カタログの式の木 `way_value_formula` へ、`GET /api/region/way-materials/{axis_id}/...` の材料と走る
 * 条件を入れたもの）で塗る軸。公開中の軸は全部これになる。
 * この型があることで、レイヤー登録・カタログ・可視性・フェッチのすべてを軸idの
 * ハードコードなしに導出できる（軸を軸スタジオで公開しただけで
 * 地図に現れる）。 */
export interface DedicatedWayValueAxis extends CatalogAxis {
  /** 走行方位で値の決まらない道がありうるか。trueの軸だけ凡例に「向きで決まらない」の行を持つ。 */
  undeterminedByBearing: boolean;
  /** 地図に塗るときの表示宣言。軸と同じカタログの行から作るため、軸が在れば必ず在る。 */
  display: MapPaintDeclaration;
  /** 道の値を求める式の木。null の軸は、ルートの無い間の周りの道を塗れない（ルートの線は塗る）。 */
  wayValueFormula: components["schemas"]["WayValueFormula"] | null;
  /** `wayValueConditions`のうち、道ごとの材料の要求へ載せるもの。ほかは式の木が読む。 */
  wayMaterialConditions: readonly WayValueCondition[];
}

export function dedicatedWayValueAxesFromCatalogAxes(axes: readonly AxisCatalogEntry[]): DedicatedWayValueAxis[] {
  return axes.map((axis) => {
    const base = catalogAxisFromEntry(axis);
    return {
      ...base,
      undeterminedByBearing: axis.dynamic_way_value_undetermined_by_bearing,
      display: mapPaintDeclarationOf(axis.map_paint),
      wayValueFormula: axis.way_value_formula,
      wayMaterialConditions: axis.dynamic_way_value_material_conditions,
    };
  });
}
