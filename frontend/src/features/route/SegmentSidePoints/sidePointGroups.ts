// 区間の近くの施設を、地図の点のレイヤの種類ごとに分け、その中を地図の印の区分（先頭の軸の行）ごとに分ける。種類の名前・並び、
// 区分の名前・色・絵記号は地図の点と同じ宣言から引く。
import { distinctFacilities, facilityOf, type Facility } from "@/components/MapPopup/facilityRows";
import type { PointGlyph } from "@/lib/mapDisplay/legendFilter";
import { pointCategoryOf } from "@/lib/mapDisplay/pointLayers";
import {
  SIDE_FACILITY_LAYERS,
  sidePointAlong,
  sidePointKindId,
  type SidePointOnMap,
} from "@/lib/mapDisplay/sidePoints";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";

/** 地図の印の1区分ぶんの施設。 */
export type SidePointKind = {
  /** 地図に出す・消すの単位の鍵（`lib/mapDisplay/sidePoints.ts: sidePointKindId`）。 */
  readonly id: string;
  readonly label: string;
  /** 地図の印の色。行が色を持たなければ、地図と同じく値の無い色。 */
  readonly color: string;
  /** 地図で絵記号で描く区分の絵記号。 */
  readonly glyph?: PointGlyph;
  /** 重なりをまとめ、道のりの順に並べた施設。 */
  readonly facilities: readonly Facility[];
};

export type SidePointGroup = {
  /** 地図のレイヤのid。 */
  readonly id: string;
  readonly label: string;
  /** 施設のある区分だけを、宣言の行の並びで。 */
  readonly kinds: readonly SidePointKind[];
};

// 並びと名前は地図の「表示」のレイヤのまま。
const DECLARED = mapDisplay.layers.flatMap((layer) => {
  const declaration = SIDE_FACILITY_LAYERS.find((point) => point.attr_id === layer.id);
  return declaration === undefined ? [] : [{ id: layer.id, label: layer.label, declaration }];
});

/** 施設のある種類だけを、地図の「表示」の並びで。施設の位置は区間`section`に当てて出す。先頭の軸の区分に当たらない値の点は、
 * 地図の点の層の行に当たらず描かれないので、数えない。 */
export function sidePointGroups(
  points: readonly SidePointOnMap[],
  section: Parameters<typeof sidePointAlong>[0],
): SidePointGroup[] {
  return DECLARED.flatMap(({ id, label, declaration }) => {
    const axis = declaration.display_axes[0];
    const own = points.filter((point) => point.layer === declaration);
    const kinds = axis.categories.flatMap((category): SidePointKind[] => {
      const facilities = distinctFacilities(
        own
          .filter((point) => pointCategoryOf(axis, point.properties) === category)
          .map((point) =>
            facilityOf(declaration, point.properties, point.lngLat, sidePointAlong(section, point.lngLat)),
          ),
      );
      if (facilities.length === 0) return [];
      return [
        {
          id: sidePointKindId(declaration, category),
          label: category.label,
          color: "color" in category ? category.color : palette.semantic.no_data,
          ...("glyph" in category && "color" in category ? { glyph: category.glyph } : {}),
          facilities,
        },
      ];
    });
    return kinds.length === 0 ? [] : [{ id, label, kinds }];
  });
}
