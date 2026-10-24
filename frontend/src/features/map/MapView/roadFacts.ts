// 地図上の道をクリックしたときに出す「この道の事実」。路面タイルへ焼き込み済みの
// プロパティだけから作る。
//
// 値の対訳は生成物（materialCatalog）と点の分類の宣言から引く——
// 手書きで持つと、同じ値を地図のポップアップと軸スタジオで別の呼び方をすることになる。

import { PRIMARY_ATTRIBUTE_LABELS } from "@/features/map/layers/primaryAttributes";
import materialCatalog from "@/types/generated/material-catalog.json";
import regionTileConfig from "@/types/generated/region-tile-config.json";

/** 押した道の路面タイルの属性（列名→値）。材料の列の名前は材料カタログの`tile_property`、材料の外の列
 * （識別子・道路名）の名前は生成物`region-tile-config.json`の`road_surface.properties`が持ち、ここは列名を持たない。 */
export type RoadSurfacePopupProperties = Readonly<Record<string, unknown>>;

const COLUMNS = regionTileConfig.road_surface.properties;

function textColumn(properties: RoadSurfacePopupProperties, column: string): string | null {
  const value = properties[column];
  return typeof value === "string" && value ? value : null;
}

/** 区間インスペクタで全軸の内訳を引き直すための識別子。 */
export function roadWayId(properties: RoadSurfacePopupProperties): number | null {
  const value = properties[COLUMNS.way_id];
  return typeof value === "number" ? value : null;
}

/** 押したフィーチャーそのものの識別子（区間単位のズームでは区間の鍵、way単位のズームではway_idの文字列）。
 * **内訳を地図の色と同じ単位で計算させる**ためにそのまま送る（どちらでもbackendが受け取れる）。 */
export function roadFeatureKey(properties: RoadSurfacePopupProperties): string | null {
  return textColumn(properties, COLUMNS.feature_key);
}

export interface RoadFactRow {
  label: string;
  value: string;
}

const MATERIALS = new Map(materialCatalog.map((material) => [material.material_id, material]));
const materialLabel = (materialId: string) => MATERIALS.get(materialId)!.name;
const valueLabel = (materialId: string, value: string) =>
  (MATERIALS.get(materialId)?.value_labels as Record<string, string> | undefined)?.[value] ?? value;

/** 値の呼び名で出す事実（材料）。**路面の種類は値が無くても「不明」として出す**——
 * どの道でも最初に見たい項目で、行ごと消すと「舗装されていない」と読める。 */
const ALWAYS_SHOWN_VALUE_MATERIAL = "surface";
const VALUE_FACT_MATERIALS = ["tracktype", "smoothness"] as const;

/** 当てはまるときだけ「あり」と出す事実（材料）。タイルのどの属性を読むかは材料の宣言が持つ。 */
const PRESENT_FACT_MATERIALS = ["has_tunnel", "bridge", "oneway"] as const;

/** 材料をタイルの属性から読む。属性の名前は材料カタログの`tile_property`。 */
function tileValue(properties: RoadSurfacePopupProperties, materialId: string): unknown {
  const property = MATERIALS.get(materialId)?.tile_property;
  return property == null ? undefined : properties[property];
}

/** 道路名。`name`（通称）と`ref`（路線番号）は独立したタグで、片方だけ持つwayが多い
 * （番号だけの国道・名前だけの市道）。両方あれば「名前[番号]」として1つに畳む。対訳表を持たない第三者編集の生値。 */
export function roadDisplayName(properties: RoadSurfacePopupProperties): string | null {
  const name = textColumn(properties, COLUMNS.name);
  const ref = textColumn(properties, COLUMNS.ref);
  if (name && ref) return `${name}[${ref}]`;
  return name ?? ref;
}

/** 「項目: 値」の行。**値を持たない項目は行ごと出さない**——「なし」を並べると、
 * 実際に該当する項目が同じ密度の中に埋もれる。 */
export function roadFactRows(properties: RoadSurfacePopupProperties): RoadFactRow[] {
  const surface = tileValue(properties, ALWAYS_SHOWN_VALUE_MATERIAL);
  const rows: RoadFactRow[] = [
    {
      label: materialLabel(ALWAYS_SHOWN_VALUE_MATERIAL),
      value: typeof surface === "string" && surface ? valueLabel(ALWAYS_SHOWN_VALUE_MATERIAL, surface) : "不明",
    },
  ];
  for (const material of VALUE_FACT_MATERIALS) {
    const value = tileValue(properties, material);
    if (typeof value === "string" && value) {
      rows.push({ label: materialLabel(material), value: valueLabel(material, value) });
    }
  }
  for (const material of PRESENT_FACT_MATERIALS) {
    if (tileValue(properties, material)) rows.push({ label: materialLabel(material), value: "あり" });
  }
  return rows;
}

/** 上の帯に小さく添える、この道の事実の短い並び（路面・等級・状態の値と、当てはまるトンネル等の名前）。 */
export function roadFactSummary(properties: RoadSurfacePopupProperties): string[] {
  return roadFactRows(properties).map((row) => (row.value === "あり" ? row.label : row.value));
}

/** 材料の宣言をタイルの属性の名前（OSMのキーと同じ綴り）で引く。 */
const MATERIAL_BY_TILE_PROPERTY = new Map(
  materialCatalog.flatMap((material) => (material.tile_property === null ? [] : [[material.tile_property, material]])),
);

/** 評価を取ったときに届くタグ（OSMのキー→値）を、日本語で読める行と、そのままの値に分ける。材料の対訳がある値は材料の名前と
 * 対訳で、数の値は一次属性の名前で行にする。ほかの値（英語の生の値・登録外のキー）は、キーと値のまま返す。 */
export function roadTagRows(tags: Readonly<Record<string, string>>): { rows: RoadFactRow[]; raw: RoadFactRow[] } {
  const rows: RoadFactRow[] = [];
  const raw: RoadFactRow[] = [];
  for (const [key, value] of Object.entries(tags)) {
    const material = MATERIAL_BY_TILE_PROPERTY.get(key);
    const translated = (material?.value_labels as Record<string, string> | undefined)?.[value];
    const label = PRIMARY_ATTRIBUTE_LABELS[key];
    if (material !== undefined && translated !== undefined) rows.push({ label: material.name, value: translated });
    else if (label !== undefined && value !== "" && Number.isFinite(Number(value))) rows.push({ label, value });
    else raw.push({ label: key, value });
  }
  return { rows, raw };
}
