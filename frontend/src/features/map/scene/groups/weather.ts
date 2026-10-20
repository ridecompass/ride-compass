/** 動的気象（降水・風・災害）。
 *
 * **何を描くか（チップ・名前付きソース・描き方の種類・配信元）は源泉が配る**
 * （`mapDisplay.weatherElements`、backendの`domain/weather_elements.py: WEATHER_ELEMENTS`）。
 * 要素ごとの見た目（paint・layout・filter・記号）は`scene/groups/weatherDrawings.ts`が持つ。
 *
 * 1つのチップ（グループ）が複数の名前付きソースを持ち、ソースごとに描き方が決まっている。
 * **中身は時刻の変化で何度も入れ替わる**ため、ソースは作り直さず中身だけを差し替える。
 * **中身の種類が宣言と一致するときだけ**表示する——種類が合わないものを出すと、
 * 前の時刻の絵が残ったように見える。
 *
 * 同じ（グループ, ソース）に描き方の違う宣言が並ぶことがある（降水は60分以内がラスタ、
 * それ以降は格子の塗り）。届いた中身の種類が、そのうちどれを出すかを決める。
 */
import { mapDisplay } from "@/types/generated/mapDisplay";

import { isTilePayload, type DynamicWeatherRenderPayload } from "@/features/map/layers/dynamicWeather";
import { jmaPlaceholderTileUrl } from "@/features/map/layers/jmaDelivery";
import { withJmaTileProtocol } from "@/features/map/layers/jmaTileProtocol";

import type { MapSceneImage } from "@/features/map/scene/mapScene";
import { declareGroup, type SceneLayerEntry, type SceneSourceEntry } from "@/features/map/scene/mapSceneGroups";
import { sceneSourceId, type SceneSourceId } from "@/features/map/scene/sceneBuilders";
import { drawingOf, type DeclaredElement, type Drawing } from "./weatherDrawings";

type WeatherRenderKind = DeclaredElement["kind"];

/** 描き方ごとの、重なりの段とレイヤーの型。 */
const LAYER_OF_KIND = {
  rasterTile: { tier: "area", type: "raster" },
  gridFill: { tier: "area", type: "fill" },
  vectorTile: { tier: "observedLine", type: "line" },
  outline: { tier: "observedLine", type: "line" },
  gridMark: { tier: "point", type: "symbol" },
} as const satisfies Record<WeatherRenderKind, Pick<SceneLayerEntry, "tier" | "type">>;

/** ソースへ渡す中身。タイルのURLか、GeoJSONか。 */
type SourceContent = { readonly tiles: readonly string[] } | { readonly data: unknown };

const EMPTY_FEATURE_COLLECTION = { type: "FeatureCollection", features: [] } as const;

/** 源泉の宣言1件を、地図へ渡すソース・レイヤーの材料へ移したもの。 */
type WeatherElement = {
  readonly group: string;
  readonly source: string;
  readonly kind: WeatherRenderKind;
  readonly drawing: Drawing;
  readonly sourceSpec: SceneSourceEntry["spec"];
  readonly sourceLayer?: string;
  /** 中身が届く前の中身。**タイルを持たないソース宣言は成り立たない**ため、タイルのソースは
   * 届くまでの間も架空のURLを指す（GeoJSONは同じ理由で空の中身を持つ）。**このURLは実際に要求されうる**
   * ——開発サーバーでは二重実行で一瞬表示状態になりうるので、配信元へ無駄な要求が
   * 飛んでも害のない先にしておく。 */
  readonly placeholder: SourceContent;
};

function sourceOf(element: DeclaredElement): Pick<WeatherElement, "sourceSpec" | "sourceLayer" | "placeholder"> {
  switch (element.kind) {
    case "rasterTile":
      return {
        sourceSpec: {
          type: "raster",
          tileSize: 256,
          minzoom: element.tile.minZoom,
          maxzoom: element.tile.maxZoom,
        },
        placeholder: { tiles: [jmaPlaceholderTileUrl(element)] },
      };
    case "vectorTile":
      return {
        sourceSpec: { type: "vector", minzoom: element.tile.minZoom, maxzoom: element.tile.maxZoom },
        sourceLayer: element.tile.vectorLayer,
        placeholder: { tiles: [jmaPlaceholderTileUrl(element)] },
      };
    case "gridFill":
    case "gridMark":
    case "outline":
      return { sourceSpec: { type: "geojson" }, placeholder: { data: EMPTY_FEATURE_COLLECTION } };
  }
}

/** 並びは源泉の宣言のまま。同じ段（`LAYER_OF_KIND`）の中ではこの並びが重なり順になる。 */
const WEATHER_ELEMENTS: readonly WeatherElement[] = mapDisplay.weatherElements.map((element) => ({
  group: element.group,
  source: element.source,
  kind: element.kind,
  drawing: drawingOf(element),
  ...sourceOf(element),
}));

export type WeatherState = {
  /** 表示ON/OFFと中身。鍵は`weatherElementKey`が作る。 */
  readonly shown: ReadonlyMap<string, { readonly visible: boolean; readonly payload?: DynamicWeatherRenderPayload }>;
};

export function weatherElementKey(element: Pick<WeatherElement, "group" | "source">): string {
  return `${element.group}/${element.source}`;
}

const WEATHER_IMAGES: readonly MapSceneImage[] = WEATHER_ELEMENTS.flatMap((element) =>
  element.drawing.icon === undefined ? [] : [element.drawing.icon],
);

/** 要素が持つソースの名前。**チップidは源泉の語をそのまま使う**——ここで別の呼び名を
 * 付け直すと、源泉が知っているものに画面だけの語彙が重なる。1要素＝1ソース（要素ごとに
 * 配信先が違うため相乗りできない）。
 * **描き方も名前に含める**——同じ名前付きソースを描き方違いで2要素が名乗る（降水の`main`は
 * 配信元のラスタとMSMの格子点の升目の塗り）。描き方を落とすとソースが1本へ畳まれ、後から名乗った側の
 * レイヤーが種類の合わないソースを指して、そのレイヤーだけが黙って描かれない。 */
function weatherSourceId(element: Pick<WeatherElement, "group" | "source" | "kind">): SceneSourceId {
  return sceneSourceId(`${element.group}-${element.source}-${element.kind}`);
}

/** 届いた中身をソースへ渡す形へ移す。配信元のタイルは自前のプロトコル経由で取りに行く（空タイルの肩代わり・
 * 失敗の観測）。 */
function contentOf(payload: DynamicWeatherRenderPayload | undefined, placeholder: SourceContent): SourceContent {
  if (payload === undefined) return placeholder;
  return isTilePayload(payload) ? { tiles: [withJmaTileProtocol(payload.tileUrlTemplate)] } : { data: payload.geojson };
}

export const weatherGroup = declareGroup<WeatherState>((state) => {
  const sources: SceneSourceEntry[] = [];
  const layers: SceneLayerEntry[] = [];

  for (const element of WEATHER_ELEMENTS) {
    const shown = state.shown.get(weatherElementKey(element));
    const payload = shown?.payload?.kind === element.kind ? shown.payload : undefined;
    const id = weatherSourceId(element);
    const { drawing } = element;

    const sourceLayer = element.sourceLayer === undefined ? {} : { sourceLayer: element.sourceLayer };
    sources.push({ id, spec: element.sourceSpec, ...sourceLayer, ...contentOf(payload, element.placeholder) });

    const visible = (shown?.visible ?? false) && payload !== undefined;
    const layerOf = (role: string, paint: SceneLayerEntry["paint"]): SceneLayerEntry => ({
      role,
      ...LAYER_OF_KIND[element.kind],
      source: id,
      ...sourceLayer,
      paint,
      ...(drawing.layout === undefined ? {} : { layout: drawing.layout }),
      visible,
      ...(drawing.filter === undefined ? {} : { filter: drawing.filter }),
    });
    // 縁取りは同じ段の中で主の線より先に積み、下に置く。
    if (drawing.casing !== undefined) layers.push(layerOf(`${element.kind}-casing`, drawing.casing.paint));
    layers.push(layerOf(element.kind, drawing.paint));
  }

  return { sources, layers, images: WEATHER_IMAGES };
});
