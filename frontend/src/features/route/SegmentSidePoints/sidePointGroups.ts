// 区間の近くの点を、地図の点のレイヤの種類ごとに分け、その中を地図の印の区分（先頭の軸の行）ごとに分ける。種類の名前・並び、
// 区分の名前・色・絵記号は地図の点と同じ宣言から引く。
import type { PointGlyph } from "@/lib/mapDisplay/legendFilter";
import { pointCategoryOf, POINT_LAYERS } from "@/lib/mapDisplay/pointLayers";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import type { RoutePoint } from "@/types/route";

/** 地図の印の1区分ぶんの点。 */
export type SidePointKind = {
  /** 地図に出す・消すの単位の鍵（種類と区分の鍵の組）。 */
  readonly id: string;
  readonly label: string;
  /** 地図の印の色。行が色を持たなければ、地図と同じく値の無い色。 */
  readonly color: string;
  /** 地図で絵記号で描く区分の絵記号。 */
  readonly glyph?: PointGlyph;
  readonly points: readonly RoutePoint[];
};

export type SidePointGroup = {
  /** 地図のレイヤのid。応答の点の`layer`でもある。 */
  readonly id: string;
  readonly label: string;
  /** 点のある区分だけを、宣言の行の並びで。 */
  readonly kinds: readonly SidePointKind[];
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
    const axis = declaration.display_axes[0];
    const own = points.filter((point) => point.layer === id);
    const kinds = axis.categories.flatMap((category): SidePointKind[] => {
      const inKind = own.filter((point) => pointCategoryOf(axis, point.properties) === category);
      if (inKind.length === 0) return [];
      return [
        {
          id: `${id}:${category.key}`,
          label: category.label,
          color: "color" in category ? category.color : palette.semantic.no_data,
          ...("glyph" in category && "color" in category ? { glyph: category.glyph } : {}),
          points: inKind,
        },
      ];
    });
    return kinds.length === 0 ? [] : [{ id, label, kinds }];
  });
}
