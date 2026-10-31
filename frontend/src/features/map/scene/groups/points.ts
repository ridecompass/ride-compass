/** 点で示すもの（停止要因POI・補給休憩POI・事故地点）。
 *
 * **何を点で描くかは源泉が決める**。点になりうる属性は源泉（生成物`primaryAttributes.ts`の
 * `geometry="point"`）が持ち、そのうち表示の定義（`display_axes`）を持つものだけが出る
 * （交差点は表示の定義を持たないので出ない）。
 *
 * 点のソースは、配信される点のタイルの一覧（生成物`region-tile-config.json`の`point_layers`）から1つずつ作り、
 * レイヤーは自分の`tile_kind`のソースを読む。**同じタイルを2つ以上のレイヤーが分け合うときは、種別の集合で分ける**
 * ——分ける条件を持たないと互いの点が混ざる。その集合は源泉の表示の行（`display_axes`の値）から
 * 取る。行が種別を取りこぼすと、その種別の点は地図から消える——行と種別の一覧が一致することは
 * backendのテスト（`test_primary_attributes.py`）が全種別で確かめる。
 *
 * 点の形も源泉が決める。点は先頭の軸の行が持つ絵記号（`glyph`。形は`components/PointIconSwatch/PointIconSwatch.tsx: POINT_GLYPHS`）
 * で描く。描き始める縮尺（`point_min_zoom`）と、重なったときどの層の印を残すか（`point_priority`）・同じ層の中でどの印を残すか
 * （`point_priority_axes`）も源泉の宣言を読む。
 * 重なる印は地図が省く（`pointLook`）。
 *
 * 近い点はタイルの側で1つの代表点に束ねてあり、代表点は束ねた点の数を持つ（`mapDisplay.point.countProperty`）。2点以上を
 * 束ねた代表点は、点の右に数を出す。
 *
 * 行が出ている間は、同じ種類の基礎地図の店・施設の印を隠す（`BASEMAP_POIS_BY_ROW`）。
 *
 * **タイルの世代が届くまでソースを作らない**。先に作ると、世代の違う中身がブラウザの
 * キャッシュへ載って以後ずっと残る。
 */
import type { BasemapPoiKinds } from "@/features/map/layers/mapStyleOps";
import { sceneLayerId, sceneSourceId, valueInExpression, type SceneSourceId } from "@/features/map/scene/sceneBuilders";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import regionTileConfig from "@/types/generated/region-tile-config.json";
import type { FilterSpecification } from "maplibre-gl";

import type { PointGlyph } from "@/lib/mapDisplay/legendFilter";
import {
  isPointTileLayer,
  POINT_LAYERS,
  pointIconScales,
  sizeAxis,
  type PointAxis,
  type PointLayer,
  type PointTileLayer,
} from "@/lib/mapDisplay/pointLayers";

import { drawPointIcon } from "@/features/map/layers/pointIcon";
import { POINT_GLYPHS, type PointFrame } from "@/components/PointIconSwatch/PointIconSwatch";
import type { MapSceneImage } from "@/features/map/scene/mapScene";
import { declareGroup, type SceneLayerEntry, type SceneSourceEntry } from "@/features/map/scene/mapSceneGroups";

const POINT = mapDisplay.point;

/** 配信される点のタイルの名前 → source-layer。 */
const POINT_TILE_SOURCE_LAYERS: Readonly<Record<PointTileLayer, string>> = regionTileConfig.point_layers;

/** 配信される点のタイルの名前の一覧。 */
export const POINT_TILE_LAYERS = Object.keys(POINT_TILE_SOURCE_LAYERS).filter(isPointTileLayer);

/** 点のタイルごとの地図のソースとsource-layer。 */
export const POINT_TILE_SOURCES = Object.fromEntries(
  POINT_TILE_LAYERS.map((name) => [
    name,
    { sourceId: sceneSourceId(`point-${name}`), sourceLayer: POINT_TILE_SOURCE_LAYERS[name] },
  ]),
) as Readonly<Record<PointTileLayer, { readonly sourceId: SceneSourceId; readonly sourceLayer: string }>>;

/** 押された地物のレイヤーidから、点の宣言を引く関数。idは点のタイルのソースと役割`roleOf(宣言)`から決める。 */
export function pointLayerLookup(
  roleOf: (layer: PointLayer) => string,
): (sceneLayerIdOfFeature: string) => PointLayer | undefined {
  const byId = new Map(
    POINT_LAYERS.map((layer) => [sceneLayerId(POINT_TILE_SOURCES[layer.tile_kind].sourceId, roleOf(layer)), layer]),
  );
  return (sceneLayerIdOfFeature) => byId.get(sceneLayerIdOfFeature);
}

/** 押された地物のレイヤーidが点のレイヤーなら、その点の宣言。 */
export const pointLayerOfSceneLayer = pointLayerLookup((layer) => layer.attr_id);

/** 常に効く絞り込み。同じタイル・同じsource-layerを2つ以上のレイヤーが分け合うときは、
 * 自分の行に属する値だけを通す（持たないと互いの点が混ざる）。 */
export function baseFilter(layer: PointLayer): FilterSpecification | undefined {
  if (POINT_LAYERS.filter((other) => other.tile_kind === layer.tile_kind).length < 2) return undefined;
  const axis = layer.display_axes[0];
  const values = axis.categories.flatMap((category) => [...category.values]);
  return valueInExpression(valueOf(axis), values) as unknown as FilterSpecification;
}

export type PointState = {
  /** タイルの配信先。**世代が届くまでは null**——その間は何も作らない。 */
  readonly tiles: {
    readonly urls: Readonly<Record<PointTileLayer, readonly string[]>>;
    readonly minZoom: number;
    readonly maxZoom: number;
  } | null;
  /** 役割ごとの表示ON/OFF。 */
  readonly visible: Readonly<Record<string, boolean>>;
  /** 軸の鍵ごとの、凡例で隠した行の鍵。 */
  readonly hiddenKeys: Readonly<Record<string, readonly string[]>>;
};

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

/** 出ている行が隠す基礎地図の店・施設の種類。凡例で隠した行のぶんは隠さない。 */
function basemapPoisHiddenBy(layer: PointLayer, hiddenKeys: PointState["hiddenKeys"]): BasemapPoiKinds | undefined {
  const byRow: Readonly<Record<string, BasemapPoiKinds | undefined>> | undefined = BASEMAP_POIS_BY_ROW[layer.attr_id];
  const axis = layer.display_axes[0];
  if (byRow === undefined) return undefined;
  const hidden = hiddenKeys[pointAxisKey(layer, axis)] ?? [];
  const shown = axis.categories.filter((c) => !hidden.includes(c.key)).flatMap((c) => byRow[c.key] ?? []);
  return {
    class: shown.flatMap((kinds) => kinds.class),
    subclass: shown.flatMap((kinds) => kinds.subclass),
  };
}

/** 押したときに拾う対象。**どの点も共通の`point`を名乗る**ので、点を1枚足しても
 * 拾う側の判定は変わらない。 */
export const POINT_HIT_TARGET = "point";

/** 軸の絞り込みの鍵。役割をまたいで同じ軸名を使えるようにする。 */
export function pointAxisKey(layer: PointLayer, axis: PointAxis): string {
  return `${layer.attr_id}:${axis.key}`;
}

function valueOf(axis: PointAxis): unknown {
  return ["get", axis.property];
}

/** 点の値がその行に入るか。 */
function categoryMatch(axis: PointAxis, category: PointAxis["categories"][number]): unknown {
  return valueInExpression(valueOf(axis), category.values);
}

/** 通す分類だけを残す絞り込み。軸が複数あるときはすべてANDで効く。 */
function layerFilter(layer: PointLayer, hiddenKeys: PointState["hiddenKeys"]): FilterSpecification | undefined {
  const clauses: unknown[] = [];
  const base = baseFilter(layer);
  if (base !== undefined) clauses.push(base);
  for (const axis of layer.display_axes) {
    const hidden = hiddenKeys[pointAxisKey(layer, axis)] ?? [];
    if (hidden.length === 0) continue;
    const values = axis.categories.filter((c) => hidden.includes(c.key)).flatMap((c) => [...c.values]);
    if (values.length === 0) continue;
    clauses.push(["!", valueInExpression(valueOf(axis), values)]);
  }
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0] as FilterSpecification;
  return ["all", ...clauses] as unknown as FilterSpecification;
}

type GlyphCategory = Extract<PointAxis["categories"][number], { glyph: string; color: string }>;

/** 絵記号で描くレイヤーの行。源泉は先頭の軸の行の全部に付けるか、どれにも付けない。 */
function glyphCategories(layer: PointLayer): readonly GlyphCategory[] {
  const categories: readonly PointAxis["categories"][number][] = layer.display_axes[0].categories;
  return categories.filter((category): category is GlyphCategory => "glyph" in category && "color" in category);
}

/** 地図へ登録する絵の名前。**登録側と参照側が同じ1つを使う**（綴りがずれると点が出ない）。 */
function pointIconId(layer: PointLayer, category: GlyphCategory, frame: PointFrame): string {
  const look = "sign" in POINT_GLYPHS[category.glyph] ? "sign" : frame;
  return `point-icon:${layer.attr_id}:${category.key}:${look}`;
}

/** 層の点が使う枠。名前を持つ層は押せる点（四角）と押せない点（丸）の両方、名前を持たない層は丸だけ。標識の絵は枠に依らない。 */
function layerFrames(layer: PointLayer): readonly PointFrame[] {
  return layer.point_name_property === null ? ["circle"] : ["box", "circle"];
}

/** 点の絵（名前・下地の色・絵記号・枠）。 */
export const POINT_ICONS: readonly { id: string; color: string; glyph: PointGlyph; frame: PointFrame }[] =
  POINT_LAYERS.flatMap((layer) =>
    glyphCategories(layer).flatMap((category) =>
      layerFrames(layer).map((frame) => ({
        id: pointIconId(layer, category, frame),
        color: category.color,
        glyph: category.glyph,
        frame,
      })),
    ),
  );

function iconImageExpression(layer: PointLayer, categories: readonly GlyphCategory[]): unknown {
  const axis = layer.display_axes[0];
  const imageOf = (frame: PointFrame) => [
    "case",
    ...categories.flatMap((category) => [categoryMatch(axis, category), pointIconId(layer, category, frame)]),
    "",
  ];
  const named = namedExpression(layer);
  return named === null ? imageOf("circle") : ["case", named, imageOf("box"), imageOf("circle")];
}

/** 名前を持つ層の、名前の無い点（押せない点）の濃さの割合。押せるかは主に枠の形（`PointFrame`）で見分け、濃さは控えめに添える。
 * 名前を持たない層の点は全部押せないので、薄くしない。 */
const UNNAMED_OPACITY_RATIO = 0.8;

/** 名前のある点か（名前の欄が空でないか、束ねた中の名前のある点の欄を持つか）。押せる点を描き分けるため、
 * `lib/mapDisplay/pointLayers.ts: pointPlaceName`・`pointMembers` が読む欄を描き方の式で読む。名前を持たない層は null。 */
function namedExpression(layer: PointLayer): unknown | null {
  const nameProperty = layer.point_name_property;
  if (nameProperty === null) return null;
  return ["any", ["all", ["has", nameProperty], ["!=", ["get", nameProperty], ""]], ["has", POINT.membersProperty]];
}

/** 名前のある点と名前を持たない層の点は`value`のまま、名前を持つ層の名前の無い点は`ratio`を掛けた値。 */
function byNamed(layer: PointLayer, value: unknown, ratio: number): unknown {
  const named = namedExpression(layer);
  if (named === null) return value;
  const unnamed = typeof value === "number" ? value * ratio : ["*", value, ratio];
  return ["case", named, value, unnamed];
}

/** 点の大きさの倍率。点の大きさを持つ軸（事故の重大度等）があれば、行ごとの倍率。 */
function iconScaleExpression(layer: PointLayer): unknown {
  const axis = sizeAxis(layer);
  if (axis === undefined) return 1;
  const scales = pointIconScales(axis);
  return ["case", ...axis.categories.flatMap((category, i) => [categoryMatch(axis, category), scales[i]]), 1];
}

/** 同じ層の中で重なった印をどれから置くか（小さい値の印から置かれて残る）。宣言した軸（`point_priority_axes`）の行の順で
 * 決め、前の軸ほど強い。軸で決まらない印は束ねた点の数の多い印から置く——数の項は 0 より大きく 1 未満なので、軸の順を越えない。 */
function sortKeyExpression(layer: PointLayer): unknown {
  let rank: unknown = 0;
  for (const key of layer.point_priority_axes) {
    const axis = layer.display_axes.find((candidate) => candidate.key === key) as PointAxis;
    const n = axis.categories.length;
    const index = ["case", ...axis.categories.flatMap((category, i) => [categoryMatch(axis, category), i]), n];
    rank = ["+", ["*", rank, n + 1], index];
  }
  return ["+", rank, ["/", 1, ["+", COUNT, 1]]];
}

/** 積む順（下から）に並べた点の層。重なった印は上に積んだ層の印から置かれるので、残す順（`point_priority`）の大きい層を上に積む。
 * 同じ順の層は宣言の順のまま。 */
export const STACKED_POINT_LAYERS: readonly PointLayer[] = [...POINT_LAYERS].sort(
  (a, b) => a.point_priority - b.point_priority,
);

/** 色を焼き込んだ絵なので、記号のレイヤーは色を付けない。 */
export const POINT_IMAGES: readonly MapSceneImage[] = POINT_ICONS.map((icon) => ({
  id: icon.id,
  draw: () => {
    const { data, pixelRatio } = drawPointIcon(icon.color, icon.glyph, icon.frame);
    return { data, options: { pixelRatio } };
  },
}));

/** 束ねた点の数の字の大きさ（画素）。 */
const COUNT_TEXT_SIZE_PX = 12;
/** 数の字。基礎地図（OpenFreeMap の liberty）の字の置き場にある字体を名指す（無い字体は字が出ない）。 */
const COUNT_TEXT_FONT = ["Noto Sans Bold"];

const COUNT = ["to-number", ["get", POINT.countProperty], 1];

/** 点の層の印（読むタイル・押したときに拾う対象・見た目）。重なりは MapLibre の既定のまま（ほかの記号とぶつかる印は描かず、寄せて重ならなくなると出る）で、点の層どうし・
 * 区間の近くの点・基礎地図の文字とも判定する。同じ層の中で重なると、残す順（`sortKeyExpression`）の先の印を残す。2点以上を束ねた代表点は、同じ印の文字として右に数を出す（数だけが残ることは無い）。
 * 名前を持つ層の押せない点（名前の無い点）は丸い枠で少し薄く描く。描き始める縮尺を宣言した層は、それより引いた縮尺では描かない。 */
export function pointLook(
  layer: PointLayer,
): Pick<SceneLayerEntry, "source" | "sourceLayer" | "type" | "paint" | "layout" | "minzoom" | "hitTargets"> {
  return {
    source: POINT_TILE_SOURCES[layer.tile_kind].sourceId,
    sourceLayer: POINT_TILE_SOURCES[layer.tile_kind].sourceLayer,
    type: "symbol",
    hitTargets: [POINT_HIT_TARGET],
    ...(layer.point_min_zoom === null ? {} : { minzoom: layer.point_min_zoom }),
    paint: {
      "icon-opacity": byNamed(layer, POINT.opacityByLayer[layer.attr_id] ?? 1, UNNAMED_OPACITY_RATIO),
      "text-color": palette.semantic.mark_glyph,
      "text-halo-color": palette.semantic.mark_halo,
      "text-halo-width": 1.5,
    },
    layout: {
      "icon-image": iconImageExpression(layer, glyphCategories(layer)),
      "icon-size": iconScaleExpression(layer),
      "symbol-sort-key": sortKeyExpression(layer),
      "text-field": ["case", [">", COUNT, 1], ["to-string", COUNT], ""],
      "text-font": COUNT_TEXT_FONT,
      "text-size": COUNT_TEXT_SIZE_PX,
      "text-anchor": "left",
      "text-offset": ["literal", [POINT.iconSizePx / 2 / COUNT_TEXT_SIZE_PX, 0]],
    },
  };
}

export const pointGroup = declareGroup<PointState>((state) => {
  if (state.tiles === null) return { sources: [], layers: [] };
  const tiles = state.tiles;

  const sources: readonly SceneSourceEntry[] = POINT_TILE_LAYERS.map((name) => ({
    id: POINT_TILE_SOURCES[name].sourceId,
    spec: { type: "vector", minzoom: tiles.minZoom, maxzoom: tiles.maxZoom },
    sourceLayer: POINT_TILE_SOURCES[name].sourceLayer,
    tiles: tiles.urls[name],
  }));

  const points: readonly SceneLayerEntry[] = STACKED_POINT_LAYERS.map((layer) => ({
    role: layer.attr_id,
    tier: "point",
    ...pointLook(layer),
    visible: state.visible[layer.attr_id] === true,
    filter: layerFilter(layer, state.hiddenKeys),
    hidesBasemapPois: basemapPoisHiddenBy(layer, state.hiddenKeys),
  }));

  return { sources, layers: points, images: POINT_IMAGES };
});
