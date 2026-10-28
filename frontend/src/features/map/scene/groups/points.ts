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
 * 点の形も源泉が決める。先頭の軸の行が絵記号（`glyph`）を持つレイヤーは、行の色の角丸四角に絵記号を載せた
 * 記号で描き、持たないレイヤーは丸い点で描く。重なる印は地図が省く（`pointLook`）。
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
  pointCategoryRadiusPx,
  sizeAxis,
  type PointAxis,
  type PointLayer,
  type PointTileLayer,
} from "@/lib/mapDisplay/pointLayers";

import { drawPointDot, drawPointIcon } from "@/features/map/layers/pointIcon";
import type { PointFrame } from "@/components/PointIconSwatch/PointIconSwatch";
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

/** 地図のレイヤーidから点の宣言を引く。idは`pointGroup`と同じソースと役割から決める。 */
const POINT_LAYER_BY_SCENE_ID = new Map(
  POINT_LAYERS.map((layer) => [sceneLayerId(POINT_TILE_SOURCES[layer.tile_kind].sourceId, layer.attr_id), layer]),
);

/** 押された地物のレイヤーidが点のレイヤーなら、その点の宣言。 */
export function pointLayerOfSceneLayer(sceneLayerIdOfFeature: string): PointLayer | undefined {
  return POINT_LAYER_BY_SCENE_ID.get(sceneLayerIdOfFeature);
}

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
  return `point-icon:${layer.attr_id}:${category.key}:${frame}`;
}

/** 層の点が使う枠。名前を持つ層は押せる点（四角）と押せない点（丸）の両方、名前を持たない層は丸だけ。 */
function layerFrames(layer: PointLayer): readonly PointFrame[] {
  return layer.point_name_property === null ? ["circle"] : ["box", "circle"];
}

/** 絵記号で描く点の絵（名前・下地の色・絵記号・枠）。 */
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

/** 名前の無い点（押せない点）の濃さの割合。押せるかは主に枠の形（`PointFrame`）で見分け、濃さは控えめに添える。 */
const UNNAMED_OPACITY_RATIO = 0.8;

/** 名前のある点か（名前の欄が空でないか、束ねた中の名前のある点の欄を持つか）。押せる点を描き分けるため、
 * `lib/mapDisplay/pointLayers.ts: pointPlaceName`・`pointMembers` が読む欄を描き方の式で読む。名前を持たない層は null。 */
function namedExpression(layer: PointLayer): unknown | null {
  const nameProperty = layer.point_name_property;
  if (nameProperty === null) return null;
  return ["any", ["all", ["has", nameProperty], ["!=", ["get", nameProperty], ""]], ["has", POINT.membersProperty]];
}

/** 名前のある点は`value`のまま、名前の無い点は`ratio`を掛けた値。 */
function byNamed(layer: PointLayer, value: unknown, ratio: number): unknown {
  const named = namedExpression(layer);
  const unnamed = typeof value === "number" ? value * ratio : ["*", value, ratio];
  return named === null ? unnamed : ["case", named, value, unnamed];
}

/** 絵記号の点の大きさの倍率。点の大きさを持つ軸（事故の重大度等）があれば、いちばん大きい行を1倍にし、ほかは半径の比で
 * 小さくする（絵が小さくなりすぎないよう、半径の比の半分だけ縮める）。 */
function iconScaleExpression(layer: PointLayer): unknown {
  const axis = sizeAxis(layer);
  if (axis === undefined) return 1;
  const largest = Math.max(...axis.categories.map(pointCategoryRadiusPx));
  const cases = axis.categories.flatMap((category) => [
    categoryMatch(axis, category),
    0.5 + (0.5 * pointCategoryRadiusPx(category)) / largest,
  ]);
  return ["case", ...cases, 1];
}

/** 名前の無い点だけの層（停止要因・事故等）が絵記号で描き始める縮尺。これより引いた縮尺では区分の色の丸で描く——引いた縮尺で
 * 道に沿って並ぶ点を全部絵記号にすると、地図が絵で埋まる。 */
const UNNAMED_GLYPH_MIN_ZOOM = 17;

/** 丸い点で描く縮尺を持つ層か。絵記号を持たない層はどの縮尺でも、名前の無い点だけの層は`UNNAMED_GLYPH_MIN_ZOOM`より引いた
 * 縮尺で丸い点で描く。 */
function drawsDots(layer: PointLayer): boolean {
  return glyphCategories(layer).length === 0 || layer.point_name_property === null;
}

/** 丸い点の半径の候補。点の大きさを持つ軸の行の半径と、どの行にも入らない点の既定の半径。 */
function dotRadii(layer: PointLayer): readonly number[] {
  const axis = sizeAxis(layer);
  return [...new Set([POINT.radiusPx, ...(axis?.categories.map(pointCategoryRadiusPx) ?? [])])];
}

/** 地図へ登録する丸い点の絵の名前。**登録側と参照側が同じ1つを使う**（綴りがずれると点が出ない）。 */
function pointDotId(layer: PointLayer, category: PointAxis["categories"][number], radiusPx: number): string {
  return `point-dot:${layer.attr_id}:${category.key}:${radiusPx}`;
}

/** 丸い点の絵（名前・色・半径）。重なった印を地図に省かせるため、丸い点も絵の印で描く——丸のレイヤー（`circle`）は
 * MapLibre の重なりの判定に加わらない。 */
export const POINT_DOTS: readonly { id: string; color: string; radiusPx: number }[] = POINT_LAYERS.filter(
  drawsDots,
).flatMap((layer) =>
  layer.display_axes[0].categories.flatMap((category) =>
    dotRadii(layer).map((radiusPx) => ({ id: pointDotId(layer, category, radiusPx), color: category.color, radiusPx })),
  ),
);

/** 色を焼き込んだ絵なので、記号のレイヤーは色を付けない。 */
export const POINT_IMAGES: readonly MapSceneImage[] = [
  ...POINT_ICONS.map((icon) => ({ id: icon.id, draw: () => drawPointIcon(icon.color, icon.glyph, icon.frame) })),
  ...POINT_DOTS.map((dot) => ({ id: dot.id, draw: () => drawPointDot(dot.color, dot.radiusPx) })),
].map(({ id, draw }) => ({
  id,
  draw: () => {
    const { data, pixelRatio } = draw();
    return { data, options: { pixelRatio } };
  },
}));

/** 丸い点の絵の名前の式。色は先頭の軸の行、半径は点の大きさを持つ軸の行で決まる。 */
function dotImageExpression(layer: PointLayer): unknown {
  const axis = layer.display_axes[0];
  const size = sizeAxis(layer);
  const imageOf = (category: PointAxis["categories"][number]) =>
    size === undefined
      ? pointDotId(layer, category, POINT.radiusPx)
      : [
          "case",
          ...size.categories.flatMap((row) => [
            categoryMatch(size, row),
            pointDotId(layer, category, pointCategoryRadiusPx(row)),
          ]),
          pointDotId(layer, category, POINT.radiusPx),
        ];
  return ["case", ...axis.categories.flatMap((category) => [categoryMatch(axis, category), imageOf(category)]), ""];
}

/** 束ねた点の数の字の大きさ（画素）。 */
const COUNT_TEXT_SIZE_PX = 12;
/** 数の字。基礎地図（OpenFreeMap の liberty）の字の置き場にある字体を名指す（無い字体は字が出ない）。 */
const COUNT_TEXT_FONT = ["Noto Sans Bold"];

const COUNT = ["to-number", ["get", POINT.countProperty], 1];

/** 印の描き方のうち、丸い点と絵記号で違うもの。 */
type PointMark = {
  readonly image: unknown;
  readonly size: unknown;
  readonly opacity: unknown;
  /** 印の中心から右の縁までの画素（数をその右に出す）。 */
  readonly halfWidthPx: number;
};

/** 点の層の印。重なりは MapLibre の既定のまま（ほかの記号とぶつかる印は描かず、寄せて重ならなくなると出る）で、点の層どうし・
 * 区間の近くの点・基礎地図の文字とも判定する。2点以上を束ねた代表点は、同じ印の文字として右に数を出す（数だけが残ることは無い）。
 * 押せない点（名前の無い点）は丸い枠で少し薄く描く。名前の無い点だけの層は、`UNNAMED_GLYPH_MIN_ZOOM`より引いた縮尺で丸い点で描く。 */
export function pointLook(layer: PointLayer): Pick<SceneLayerEntry, "type" | "paint" | "layout"> {
  const glyphs = glyphCategories(layer);
  const opacity = POINT.opacityByLayer[layer.attr_id] ?? 1;
  const dot: PointMark = {
    image: dotImageExpression(layer),
    size: 1,
    opacity,
    halfWidthPx: Math.max(...dotRadii(layer)),
  };
  const glyph: PointMark | null =
    glyphs.length === 0
      ? null
      : {
          image: iconImageExpression(layer, glyphs),
          size: iconScaleExpression(layer),
          opacity: byNamed(layer, opacity, UNNAMED_OPACITY_RATIO),
          halfWidthPx: POINT.iconSizePx / 2,
        };
  const byZoom = (pick: (mark: PointMark) => unknown): unknown => {
    if (glyph === null) return pick(dot);
    if (!drawsDots(layer)) return pick(glyph);
    return ["step", ["zoom"], pick(dot), UNNAMED_GLYPH_MIN_ZOOM, pick(glyph)];
  };
  return {
    type: "symbol",
    paint: {
      "icon-opacity": byZoom((mark) => mark.opacity),
      "text-color": palette.semantic.mark_glyph,
      "text-halo-color": palette.semantic.mark_halo,
      "text-halo-width": 1.5,
    },
    layout: {
      "icon-image": byZoom((mark) => mark.image),
      "icon-size": byZoom((mark) => mark.size),
      "text-field": ["case", [">", COUNT, 1], ["to-string", COUNT], ""],
      "text-font": COUNT_TEXT_FONT,
      "text-size": COUNT_TEXT_SIZE_PX,
      "text-anchor": "left",
      "text-offset": byZoom((mark) => ["literal", [mark.halfWidthPx / COUNT_TEXT_SIZE_PX, 0]]),
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

  const points: readonly SceneLayerEntry[] = POINT_LAYERS.map((layer) => ({
    role: layer.attr_id,
    tier: "point",
    source: POINT_TILE_SOURCES[layer.tile_kind].sourceId,
    sourceLayer: POINT_TILE_SOURCES[layer.tile_kind].sourceLayer,
    ...pointLook(layer),
    visible: state.visible[layer.attr_id] === true,
    hitTargets: [POINT_HIT_TARGET],
    filter: layerFilter(layer, state.hiddenKeys),
    hidesBasemapPois: basemapPoisHiddenBy(layer, state.hiddenKeys),
  }));

  return { sources, layers: points, images: POINT_IMAGES };
});
