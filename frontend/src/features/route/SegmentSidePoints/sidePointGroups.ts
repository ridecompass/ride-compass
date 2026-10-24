// 区間の近くの点を、地図の点のレイヤの種類ごとに組む。種類の名前・並び・色・区分の呼び名・点の名前は地図の点と同じ宣言から引く。
import { pointCategoryOf, pointPlaceName, POINT_LAYERS } from "@/lib/mapDisplay/pointLayers";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import type { RoutePoint } from "@/types/route";

type SidePoint = {
  /** ルートの上の道のり（km）。 */
  readonly km: number;
  /** 道からの距離（m）。 */
  readonly offsetM: number;
  /** 軸ごとの区分の呼び名を軸の並びでつないだもの。宣言に無い値の軸は「不明」。 */
  readonly kinds: string;
  readonly name: string | null;
  /** 地図の点の色（先頭の軸の区分の色）。 */
  readonly color: string;
};

export type SidePointGroup = {
  /** 地図のレイヤのid。応答の点の`layer`でもある。 */
  readonly id: string;
  readonly label: string;
  /** 道のりの順。 */
  readonly points: readonly SidePoint[];
};

// 並びと名前は地図の「表示」のレイヤのまま。
const DECLARED = mapDisplay.layers.flatMap((layer) => {
  const declaration = POINT_LAYERS.find((point) => point.attr_id === layer.id);
  return declaration === undefined ? [] : [{ id: layer.id, label: layer.label, declaration }];
});

/** 点のある種類だけを、地図の「表示」の並びで。点は応答の道のりの順のまま。 */
export function sidePointGroups(points: readonly RoutePoint[]): SidePointGroup[] {
  return DECLARED.flatMap(({ id, label, declaration }) => {
    const own = points.filter((point) => point.layer === id);
    if (own.length === 0) return [];
    return [
      {
        id,
        label,
        points: own.map((point) => {
          const first = pointCategoryOf(declaration.display_axes[0], point.properties);
          return {
            km: point.distance_km,
            offsetM: point.offset_m,
            kinds: declaration.display_axes
              .map((axis) => pointCategoryOf(axis, point.properties)?.label ?? "不明")
              .join(" ・ "),
            name: pointPlaceName(declaration, point.properties),
            color: first !== undefined && "color" in first ? first.color : palette.semantic.no_data,
          };
        }),
      },
    ];
  });
}
