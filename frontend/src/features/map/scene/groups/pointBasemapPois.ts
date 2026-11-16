import type { BasemapPoiKinds } from "@/features/map/layers/mapStyleOps";
import type { PointLayer } from "@/lib/mapDisplay/pointLayers";

/** 行が出ている間、基礎地図から隠す店・施設の種類（点の属性 → 行の鍵 → 種類）。OpenStreetMap でない出どころから
 * 出す行が、同じ種類を基礎地図（OpenStreetMap）と同時に出さないためのもの——同じ種類を混ぜて出すと、ODbL の
 * 共有の義務がかかる。行を出していないときは基礎地図の印をそのまま出す。種類は OpenMapTiles のスキーマの`poi`の値で、
 * 行の中身（一次属性の行の説明）に当たる値を名指す。銭湯・温泉はスキーマに値が無いので隠さない。鍵は源泉の点の属性と
 * 行の鍵で縛る（行の鍵が変わると型検査で落ちる。黙って基礎地図の印が出たままになるのを防ぐ）。 */
const BASEMAP_POIS_BY_ROW: {
  readonly [L in PointLayer as L["attr_id"]]?: {
    readonly [K in L["display_axes"][number]["categories"][number]["key"]]?: BasemapPoiKinds;
  };
} = {
  supply_poi: {
    // コンビニは店全体の`class=shop`に入るので`subclass`で名指す
    convenience: { class: [], subclass: ["convenience"] },
  },
  stop_place: {
    eat_drink: { class: ["restaurant", "fast_food", "cafe", "bar", "beer", "ice_cream"], subclass: [] },
    bicycle: { class: ["bicycle", "bicycle_rental"], subclass: [] },
    // 公園・庭園・城・博物館・観光地と展望地
    scenic: { class: ["park", "garden", "castle", "museum", "attraction"], subclass: [] },
    // ホテル・旅館の類とキャンプ場
    lodging: { class: ["lodging", "campsite"], subclass: [] },
    // 寺社は文化財の一覧から出す
    temple_shrine: { class: ["place_of_worship"], subclass: [] },
  },
};

/** 出ている行が隠す基礎地図の店・施設の種類。`hiddenRows`は先頭の軸で凡例から隠した行の鍵で、そのぶんは隠さない。 */
export function basemapPoisHiddenBy(layer: PointLayer, hiddenRows: readonly string[]): BasemapPoiKinds | undefined {
  const byRow: Readonly<Record<string, BasemapPoiKinds | undefined>> | undefined = BASEMAP_POIS_BY_ROW[layer.attr_id];
  if (byRow === undefined) return undefined;
  const shown = layer.display_axes[0].categories
    .filter((c) => !hiddenRows.includes(c.key))
    .flatMap((c) => byRow[c.key] ?? []);
  return {
    class: shown.flatMap((kinds) => kinds.class),
    subclass: shown.flatMap((kinds) => kinds.subclass),
  };
}
