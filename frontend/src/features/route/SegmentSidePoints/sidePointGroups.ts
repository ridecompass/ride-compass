// 区間の近くの点を、地図の点のレイヤの種類ごとに分ける。種類の名前・並びは地図の点と同じ宣言から引く。
import { pointCategoryOf, POINT_LAYERS } from "@/lib/mapDisplay/pointLayers";
import { mapDisplay } from "@/types/generated/mapDisplay";
import type { RoutePoint } from "@/types/route";

export type SidePointGroup = {
  /** 地図のレイヤのid。応答の点の`layer`でもある。 */
  readonly id: string;
  readonly label: string;
  readonly points: readonly RoutePoint[];
};

// 並びと名前は地図の「表示」のレイヤのまま。
const DECLARED = mapDisplay.layers.flatMap((layer) => {
  const declaration = POINT_LAYERS.find((point) => point.attr_id === layer.id);
  return declaration === undefined ? [] : [{ id: layer.id, label: layer.label, declaration }];
});

/** 地図に描ける点のある種類だけを、地図の「表示」の並びで。先頭の軸の区分に当たらない値の点は、地図の点の層の行に当たらず
 * 描かれないので、数えない。 */
export function sidePointGroups(points: readonly RoutePoint[]): SidePointGroup[] {
  return DECLARED.flatMap(({ id, label, declaration }) => {
    const own = points.filter(
      (point) => point.layer === id && pointCategoryOf(declaration.display_axes[0], point.properties) !== undefined,
    );
    return own.length === 0 ? [] : [{ id, label, points: own }];
  });
}
