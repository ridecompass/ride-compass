// 地図の点（施設・事故）を1つ1行で見せるための、行の中身。地図の点の層・区間の近くの施設の印・区間の小窓の区分の一覧が
// 同じ行を読む。区分の名前・色・絵記号は地図の点と同じ宣言から引く。
import { API_BASE_URL } from "@/lib/apiBaseUrl";
import type { PointGlyph } from "@/lib/mapDisplay/legendFilter";
import { pointCategoryOf, pointPlaceName, type PointAxis } from "@/lib/mapDisplay/pointLayers";
import { formatAlongDistance } from "@/lib/geoDistance";
import type { paths } from "@/types/generated/api";
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
  readonly glyph?: PointGlyph;
  /** 区分の名前（軸の並びで「・」でつなぐ。引けない値は「不明」）。名前の無い施設は、これを名前の代わりに出す。 */
  readonly kindLabel: string;
  /** 施設の名前。名前のある施設は、名前を外の地図で探すリンクにする。 */
  readonly name: string | null;
  readonly mapUrl: string | null;
  /** 宣言が点に添える事実（「<名前> <値>」）。値の無い事実は持たない。 */
  readonly facts: readonly string[];
  /** ルートの上の位置（候補の始点からの道のりkm。画面には`FacilityOrigin`から見た前後で出す）と、道からの距離（m）。
   * 区間の近くの点だけが持つ。 */
  readonly km: number | null;
  readonly offsetM: number | null;
};

const PLACE_LINK_PATH = "/api/place-link" satisfies keyof paths;

/** 施設の点を開く外の地図（Google マップ）。閉店にデータが追いついていないことがあるので、営業を外で確かめられるようにする。
 * 外の地図の URL は backend の転送が辺りを引いて組むので、リンクはその転送を指す（押してから辺りを引いて新しいタブを開くと、
 * 待ちを挟んだ`window.open`をブラウザが止めることがある）。 */
function externalMapSearchUrl(name: string, lngLat: readonly [number, number]): string {
  const query = new URLSearchParams({ name, latitude: String(lngLat[1]), longitude: String(lngLat[0]) });
  return `${API_BASE_URL}${PLACE_LINK_PATH}?${query}`;
}

/** 1つの点の行。区分の名前は凡例と同じ宣言から引く（値は分類器が付ける内部名で、そのまま画面へ出さない）。 */
export function facilityOf(
  layer: FacilityLayer,
  properties: Readonly<Record<string, unknown>>,
  lngLat: readonly [number, number],
  along: { km: number; offsetM: number } | null = null,
): Facility {
  const name = pointPlaceName(layer, properties);
  const first = pointCategoryOf(layer.display_axes[0], properties);
  const kindLabel = layer.display_axes.map((axis) => pointCategoryOf(axis, properties)?.label ?? "不明").join("・");
  const facts = layer.point_facts.flatMap((fact) => {
    const value = properties[fact.property];
    return value == null ? [] : [`${fact.label} ${String(value)}`];
  });
  return {
    key: [layer.attr_id, kindLabel, name ?? "", ...facts, lngLat[0].toFixed(6), lngLat[1].toFixed(6)].join("|"),
    color: first !== undefined && "color" in first ? first.color : palette.semantic.no_data,
    ...(first !== undefined && "glyph" in first && "color" in first ? { glyph: first.glyph } : {}),
    kindLabel,
    name,
    mapUrl: name === null ? null : externalMapSearchUrl(name, lngLat),
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

/** 施設の位置を、ルートの上のどこから見て言うか。走行中は現在地（`riding`）、ほかは区間の小窓を開いた地点。`km`は候補の始点からの
 * 道のり（施設の`km`と同じ物差し）。 */
export type FacilityOrigin = { readonly km: number; readonly riding: boolean };

/** 施設の位置を、基準の地点から見たルートの前後で言う（「300m先」「100m手前」。走行中の先は「あと1.2km」）。始点からの道のりの
 * kmは、利用者には何の値か分からないので出さない。 */
export function facilityPosition(km: number, origin: FacilityOrigin): string {
  const aheadKm = km - origin.km;
  const distance = formatAlongDistance(Math.abs(aheadKm) * 1000);
  if (aheadKm < 0) return `${distance}手前`;
  return origin.riding ? `あと${distance}` : `${distance}先`;
}
