// 地図の点（施設・事故）を1つ1行で見せるための、行の中身。地図の点の層・区間の小窓の区分の一覧が
// 同じ行を読む。区分の名前・色・絵記号は地図の点と同じ宣言から引く。
import type { PointGlyph } from "@/lib/mapDisplay/legendFilter";
import { pointCategoryOf, type PointAxis, type PointMember } from "@/lib/mapDisplay/pointLayers";
import { formatAlongDistance } from "@/lib/geoDistance";
import palette from "@/types/generated/palette.json";

type FacilityLayer = {
  attr_id: string;
  display_axes: readonly PointAxis[];
  point_facts: readonly { property: string; label: string }[];
  point_name_property: string | null;
};

/** 施設の1行。 */
export type Facility = {
  /** 同じ場所の同じ施設を1つにまとめる鍵。 */
  readonly key: string;
  /** 地図の印の色と絵記号（先頭の軸の行）。 */
  readonly color: string;
  readonly glyph: PointGlyph;
  /** 区分の名前（軸の並びで「・」でつなぐ。引けない値は「不明」）。名前の無い施設は、これを名前の代わりに出す。 */
  readonly kindLabel: string;
  /** 施設の名前。名前のある施設は、名前を外の地図の店のページを開くリンクにする（リンクは`placeLinkQuery`が引く）。 */
  readonly name: string | null;
  /** 点の位置（経度・緯度）。外の地図のリンクを引くときに名前と一緒に渡す。 */
  readonly lngLat: readonly [number, number];
  /** 宣言が点に添える事実（「<名前> <値>」）。値の無い事実は持たない。数か所をまとめた行は、事実の代わりに数（「3か所」）を持つ。 */
  readonly facts: readonly string[];
  /** ルートの上の位置（候補の始点からの道のりkm。画面には走行中の現在地から見た前後で出す）と、道からの距離（m）。
   * ルートを選んでいる間だけ持つ。 */
  readonly km: number | null;
  readonly offsetM: number | null;
};

/** 点の中身`member`の行。区分と事実は点の属性`properties`から、区分の名前は凡例と同じ宣言から引く（値は分類器が付ける
 * 内部名で、そのまま画面へ出さない）。数か所をまとめた中身は、代表点の事実がほかの点に当たらないので、事実を添えない。 */
export function facilityOf(
  layer: FacilityLayer,
  properties: Readonly<Record<string, unknown>>,
  member: PointMember,
  along: { km: number; offsetM: number } | null = null,
): Facility {
  const { name, at: lngLat, count } = member;
  const first = pointCategoryOf(layer.display_axes[0], properties);
  const kindLabel = layer.display_axes.map((axis) => pointCategoryOf(axis, properties)?.label ?? "不明").join("・");
  const facts =
    count > 1
      ? [`${count}か所`]
      : layer.point_facts.flatMap((fact) => {
          const value = properties[fact.property];
          return value == null ? [] : [`${fact.label} ${String(value)}`];
        });
  return {
    key: [layer.attr_id, kindLabel, name ?? "", ...facts, lngLat[0].toFixed(6), lngLat[1].toFixed(6)].join("|"),
    color: first !== undefined && "color" in first ? first.color : palette.semantic.no_data,
    glyph: first !== undefined && "glyph" in first ? first.glyph : "question",
    kindLabel,
    name,
    lngLat,
    facts,
    km: along?.km ?? null,
    offsetM: along?.offsetM ?? null,
  };
}

/** 同じ場所に重なった同じ施設を1つにする（件数は出さない）。並びは、ルートの上の位置があればその順（同じ位置なら道に近い順）、
 * 無ければ元の順。 */
export function distinctFacilities(facilities: readonly Facility[]): Facility[] {
  const byKey = new Map<string, Facility>();
  for (const facility of facilities) if (!byKey.has(facility.key)) byKey.set(facility.key, facility);
  return [...byKey.values()].sort((a, b) => (a.km ?? 0) - (b.km ?? 0) || (a.offsetM ?? 0) - (b.offsetM ?? 0));
}

/** 施設の位置を、走行中の現在地（`travelledKm`。候補の始点からの道のりで、施設の`km`と同じ物差し）から見たルートの前後で言う
 * （「あと1.2km」「100m手前」）。始点からの道のりのkmは、利用者には何の値か分からないので出さない。 */
export function facilityPosition(km: number, travelledKm: number): string {
  const aheadKm = km - travelledKm;
  const distance = formatAlongDistance(Math.abs(aheadKm) * 1000);
  return aheadKm < 0 ? `${distance}手前` : `あと${distance}`;
}
