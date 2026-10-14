// 軸カタログ（`GET /api/axis-catalog`）の軸を、地図が読む形（配信の値で塗る軸）へ移す。軸の共通の項目は
// `catalogAxis.ts`が行から移し、ここは地図の表示の項目だけを足す。
//
// 軸の地図表示は`domain/axis_display.py: axis_display_for()`が軸スタジオの公開状態から都度作り、
// **ビルド時の写しは持たない**——写しを持つと、API障害時に古い軸で地図が描かれ、伝播の失敗が
// 見えなくなる。取得できるまでは軸0件で描く（`hooks/useAxisCatalog.ts`）。軸は軸スタジオで公開すれば、
// 再デプロイなしに地図のレイヤーとして現れる。

import { mapPaintDeclarationOf, type MapPaintDeclaration } from "./valueScale";
import { catalogAxisFromEntry, type CatalogAxis } from "@/lib/catalogAxis";
import type { AxisCatalogEntry } from "@/types/route";

/** 道ごとの値（`GET /api/region/dynamic-way-values/{axis_id}/...`の得点）で塗る軸。公開中の軸は全部これになる。
 * この型があることで、レイヤー登録・カタログ・可視性・フェッチのすべてを軸idの
 * ハードコードなしに導出できる（軸を軸スタジオで公開しただけで
 * 地図に現れる）。 */
export interface DedicatedWayValueAxis extends CatalogAxis {
  /** 配信が、走行方位で値の決まらない道（値がnull）を返しうるか。trueの軸だけ凡例に「向きで決まらない」の行を持つ。 */
  undeterminedByBearing: boolean;
  /** 地図に塗るときの表示宣言。軸と同じカタログの行から作るため、軸が在れば必ず在る。 */
  display: MapPaintDeclaration;
}

export function dedicatedWayValueAxesFromCatalogAxes(axes: readonly AxisCatalogEntry[]): DedicatedWayValueAxis[] {
  return axes.map((axis) => {
    const base = catalogAxisFromEntry(axis);
    return {
      ...base,
      undeterminedByBearing: axis.dynamic_way_value_undetermined_by_bearing,
      display: mapPaintDeclarationOf(axis.map_paint),
    };
  });
}
