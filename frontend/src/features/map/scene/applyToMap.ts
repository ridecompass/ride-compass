/** 画面の状態を地図へ当てる。**ここが唯一の適用の入口**。
 *
 * 状態 → 各家族の入力（`sceneInputsFrom`）→ 望ましい並び（`buildMapScene`）→
 * 差分を当てる（`applyMapScene`）の1本道。スタイルを差し替えた後の作り直しも同じ道を通り、
 * 前回との差分ではなく空から当て直す（`applyScene`の`reset`）だけが違う。
 *
 * **再描画で失われる副作用を持つ描画は、必ずここから辿れる位置へ置く。** レイヤーの
 * 追加だけでなく、filter・feature-state・visibilityで持つ表示状態も同じ。辿れないものは
 * `setStyle()`後に作り直されず、押した人の地図から消えたままになる。
 *
 * カメラは動かさない——作り直しは見た目を戻すだけで、表示範囲は利用者のもの。
 */
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";

import type { MapLayerVisibility } from "@/features/map/layers/mapLayers";
import type { DedicatedWayValueAxis } from "@/lib/mapDisplay/axisLayers";
import type { CatalogAxis } from "@/lib/catalogAxis";
import { debugLog } from "@/lib/debugLog";
import type {
  DynamicWeatherGroupState,
  DynamicWeatherLayerId,
  DynamicWeatherRenderPayload,
} from "@/features/map/layers/dynamicWeather";
import {
  areaLayerAnchor,
  hideBasemapPois,
  labelLayerAnchor,
  prepareBasemap,
  runWhenStyleReady,
} from "@/features/map/layers/mapStyleOps";
import { axisMapLayerIds } from "@/features/map/layers/mapLayers";
import type { LensId, RouteStyleMode } from "@/lib/mapDisplay/routeStyleModes";
import type { RoadMapLayerView, RouteCandidate, SelectedRouteSegment } from "@/types/route";
import { valueBands } from "@/lib/mapDisplay/valueScale";
import { findSameSegment, routeStretches, segmentPath, splitSegmentAt } from "@/lib/routeDistance";
import { tileBaseUrl } from "@/lib/tileBaseUrl";
import {
  ROAD_TILE_MAX_ZOOM,
  ROAD_TILE_MIN_ZOOM,
  landcoverTileUrl,
  pointTileUrl,
  roadSurfaceTileUrl,
  type TileVersions,
} from "@/features/map/regionApi";
import type { PointTileLayer } from "@/lib/mapDisplay/pointLayers";
import regionTileConfig from "@/types/generated/region-tile-config.json";

import { applyMapScene } from "./applyMapScene";
import type { AxisLineState, WayConditions, WayMaterials } from "./groups/axisLines";
import { POINT_TILE_LAYERS } from "./groups/points";
import type { RoadClassValues } from "./groups/roadLines";
import type { RouteState } from "./groups/routes";
import { weatherElementKey, type WeatherState } from "./groups/weather";
import { buildLegendFilterExpression } from "./sceneBuilders";
import type { SceneInputs } from "./buildScene";
import { EMPTY_MAP_SCENE, hiddenBasemapPois, type MapScene } from "./mapScene";

/** ベクタタイル内のレイヤー名。源泉が配る値をそのまま使う。 */
export const ROAD_TILE_SOURCE_LAYER = regionTileConfig.road_surface.layer_name;

/** 乗り換えられる区間1本ぶんの入力。`index`は押されたときに呼び出し側が見分ける値。 */
export interface SpliceStretchInput {
  readonly index: number;
  readonly coordinates: readonly GeoJSON.Position[];
}

/** 凡例の保存先id → 隠した行の鍵。 */
export type HiddenLegendKeys = Readonly<Record<string, readonly string[]>>;

/** 地図の見え方の状態。**状態そのものだけ**で、ここから導けるもの（どのレイヤーを出すか・
 * 家族ごとの隠した行・下敷き）はこのファイルが導く。 */
export interface SceneLook {
  readonly layerVisibility: MapLayerVisibility;
  readonly dynamicWeather: Partial<Record<DynamicWeatherLayerId, DynamicWeatherGroupState>>;
  /** ルート線の色分けのモード。 */
  readonly lens: LensId;
  /** 全道路を塗っている軸（塗っていなければnull）。 */
  readonly paintedAxisId: LensId | null;
  /** 今の範囲の道ごとの、道の線の層の値の取得結果。 */
  readonly roadClasses: { values: RoadClassValues; loading: boolean };
  /** 軸ごとの、今の範囲の道ごとの材料の取得結果。 */
  readonly wayMaterials: ReadonlyMap<string, { materials: WayMaterials; loading: boolean }>;
  /** 道の値の式が読む走る条件。 */
  readonly wayConditions: WayConditions;
  readonly hiddenLegendKeys: HiddenLegendKeys;
}

/** 地図に載るもの全部の入力。**実行時にしか決まらない値だけ**をここで集め、見た目は
 * 各グループが持つ。**sceneの側で宣言する**——上位の画面部品のpropsから借りると、
 * sceneと画面部品が互いをimportし合い、sceneの語彙が画面部品の都合で決まる。 */
type SceneWiringProps = {
  readonly look: SceneLook;
  readonly catalog: {
    readonly dedicatedAxes: readonly DedicatedWayValueAxis[];
    readonly routeStyleModes: readonly RouteStyleMode[];
    readonly roadLayers: readonly RoadMapLayerView[];
  };
  readonly routes: readonly RouteCandidate[];
  readonly selectedRouteId: string | null;
  /** 比較相手が別の道を通る区間。空なら帯を出さない。 */
  readonly spliceStretches: readonly SpliceStretchInput[];
  /** 編集中に「いま作っているルート」として描く座標列（編集していなければnull）。 */
  readonly splicedRoute: readonly GeoJSON.Position[] | null;
  /** タイルの世代。全系統が揃うまで`null`。 */
  readonly tileVersions: TileVersions | null;
  /** 詳細を見ている道（ポップアップが開いている間だけ非null）。 */
  readonly inspectedWayId: number | null;
  /** 選んだ候補の上で走り終えた距離（km）。走っていなければnull。 */
  readonly travelledKm: number | null;
  /** 道のりのグラフか地図で選んだ地点と、その地点を含む区間。選んでいなければnull。 */
  readonly selectedRouteSegment: SelectedRouteSegment | null;
  /** 地図で押して選んでいる区間の線（近くの点を描く）。押していなければnull。 */
  readonly sidePointPath: readonly (readonly [number, number])[] | null;
  /** 区間の近くの点のうち、地図から消した区分。 */
  readonly sidePointsHidden: ReadonlySet<string>;
  /** 小窓に中身を出している、区間の近くの施設の印の位置。無ければnull。 */
  readonly chosenSidePoint: readonly [number, number] | null;
};

const NO_KEYS: readonly string[] = [];
const NO_MATERIALS: WayMaterials = new Map();

/** 道の線を塗る評価軸は、レンズが塗っている1本だけ。密度の軸は線を塗らず、材料の点で見せる。 */
function isAxisShown(look: Pick<SceneLook, "paintedAxisId">, axis: Pick<CatalogAxis, "axisId">): boolean {
  return axis.axisId === look.paintedAxisId;
}

function routeStateFrom(props: SceneWiringProps): RouteState {
  const { look } = props;
  const visible = look.layerVisibility.route === true;
  const selected = props.routes.find((route) => route.id === props.selectedRouteId) ?? null;
  const mode = getRouteStyleMode(props.catalog.routeStyleModes, look.lens);
  const segments = visible ? (selected?.segments ?? []) : [];
  const bands = visible ? props.spliceStretches : [];
  const composite = visible ? props.splicedRoute : null;
  const picked = visible ? props.selectedRouteSegment : null;
  // 区間の形は、選んでいる候補の同じ区間から引く（地図で押した区間は形を持たない写し）。
  const pickedSegment =
    picked === null ? null : (findSameSegment(segments, picked.segment, (segment) => segment) ?? picked.segment);
  const hiddenBandFilter = buildLegendFilterExpression(
    mode.legend,
    look.hiddenLegendKeys[look.lens] ?? NO_KEYS,
  ) as maplibregl.FilterSpecification | null;
  return {
    visible,
    candidates: props.routes.map((route) => ({
      routeId: route.id,
      path: route.geometry.coordinates,
    })),
    selectedRouteId: props.selectedRouteId,
    segments: routeStretches(segments).flatMap(({ segment, startKm, endKm }) => {
      // 形は`segmentPath`が読み、地物の属性には載せない。
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { geometry: _geometry, ...properties } = segment;
      const travelled = { ...properties, travelled: true };
      const km = props.travelledKm;
      if (km === null || km <= startKm) return [{ path: segmentPath(segment), properties }];
      if (km >= endKm) return [{ path: segmentPath(segment), properties: travelled }];
      // 走り終えた地点で区間を分け、手前だけを薄める。
      const { before, after } = splitSegmentAt(segment, (km - startKm) / (endKm - startKm));
      return [
        { path: before, properties: travelled },
        { path: after, properties },
      ];
    }),
    segmentColor: mode.colorExpression as maplibregl.ExpressionSpecification,
    ...(mode.noDataExpression === undefined
      ? {}
      : { segmentNoData: mode.noDataExpression as maplibregl.ExpressionSpecification }),
    ...(hiddenBandFilter === null ? {} : { hiddenBandFilter }),
    spliceBands: bands.map((band) => ({
      path: band.coordinates,
      properties: { index: band.index },
    })),
    composite: composite !== null && composite.length > 1 ? { path: composite } : null,
    selectedSection: pickedSegment === null ? null : segmentPath(pickedSegment),
  };
}

/** 下敷きで描く軸。その軸の材料を見せるレイヤーが1つでも出ている間は、材料の線を隠さないよう下へ敷く。 */
function underlaidAxisIds(props: SceneWiringProps): ReadonlySet<string> {
  const visible = props.look.layerVisibility;
  return new Set(
    props.catalog.dedicatedAxes
      .filter((axis) => axisMapLayerIds(axis).some((id) => visible[id]))
      .map((axis) => axis.axisId),
  );
}

function axisStateFrom(props: SceneWiringProps, sourceLayer: string | null): AxisLineState {
  const { look } = props;
  const underlaid = underlaidAxisIds(props);
  // 式の木の無い軸は、ルートの無い間の周りの道を塗らない。
  const axes = props.catalog.dedicatedAxes.flatMap((axis) => {
    if (axis.wayValueFormula === null) return [];
    const fetched = look.wayMaterials.get(axis.axisId);
    return {
      axisId: axis.axisId,
      visible: isAxisShown(look, axis),
      bands: valueBands(axis.display),
      formula: axis.wayValueFormula,
      materials: fetched?.materials ?? NO_MATERIALS,
      loading: fetched?.loading === true,
      hiddenBandKeys: look.hiddenLegendKeys[axis.axisId] ?? NO_KEYS,
      underlay: underlaid.has(axis.axisId),
    };
  });
  return { axes, conditions: look.wayConditions, sourceLayer, roadLayerCount: props.catalog.roadLayers.length };
}

/** 届いている中身を、要素の鍵（`groups/weather.ts: weatherElementKey`）で引ける形へ移す。 */
export function weatherStateFrom(dynamicWeather: SceneLook["dynamicWeather"]): WeatherState {
  const shown = new Map<string, { visible: boolean; payload?: DynamicWeatherRenderPayload }>();
  for (const [groupId, group] of Object.entries(dynamicWeather)) {
    if (group === undefined) continue;
    for (const [sourceId, source] of Object.entries(group)) {
      if (source === undefined) continue;
      shown.set(weatherElementKey({ group: groupId, source: sourceId }), {
        visible: source.visible,
        ...(source.payload === undefined ? {} : { payload: source.payload }),
      });
    }
  }
  return { shown };
}

/** 点のタイルごとのURL。 */
function pointTileUrls(versions: TileVersions): Record<PointTileLayer, readonly string[]> {
  const urls = {} as Record<PointTileLayer, readonly string[]>;
  for (const name of POINT_TILE_LAYERS) urls[name] = [pointTileUrl(versions, name)];
  return urls;
}

export function sceneInputsFrom(props: SceneWiringProps): SceneInputs {
  // 世代が届く前にタイルのソースを作ると、世代の違う中身がブラウザのキャッシュへ載る。
  const versions = props.tileVersions;
  const zoom = { minZoom: ROAD_TILE_MIN_ZOOM, maxZoom: ROAD_TILE_MAX_ZOOM };
  const roadTiles =
    versions === null ? null : { urls: [roadSurfaceTileUrl(versions)], sourceLayer: ROAD_TILE_SOURCE_LAYER, ...zoom };
  // 家族はどれも自分の役割の鍵だけを読むため、状態をそのまま渡す。
  const visible = props.look.layerVisibility;
  const hiddenKeys = props.look.hiddenLegendKeys;
  return {
    area: {
      visible,
      tileOrigin: tileBaseUrl(),
      landcoverTileUrl: landcoverTileUrl(),
    },
    road: {
      layers: props.catalog.roadLayers,
      tiles: roadTiles,
      visible,
      hiddenKeys,
      classes: props.look.roadClasses.values,
      loading: props.look.roadClasses.loading,
      inspectedWayId: props.inspectedWayId,
    },
    axis: axisStateFrom(props, roadTiles?.sourceLayer ?? null),
    point: {
      tiles: versions === null ? null : { urls: pointTileUrls(versions), ...zoom },
      visible: props.look.layerVisibility,
      hiddenKeys,
    },
    weather: weatherStateFrom(props.look.dynamicWeather),
    route: routeStateFrom(props),
    sidePoint: {
      path: props.sidePointPath,
      hidden: props.sidePointsHidden,
      tilesReady: versions !== null,
      chosen: props.chosenSidePoint,
    },
  };
}

/** 地図へ当てた宣言を地図ごとに覚える。スタイルを差し替えた後は `reset` で作り直す。 */
const appliedScene = new WeakMap<MapLibreMap, MapScene>();

export function applyScene(map: MapLibreMap, scene: MapScene, options: { reset?: boolean } = {}) {
  runWhenStyleReady(map, () => {
    prepareBasemap(map);
    hideBasemapPois(map, hiddenBasemapPois(scene));
    applyMapScene(map, {
      scene,
      previous: options.reset === true ? EMPTY_MAP_SCENE : (appliedScene.get(map) ?? EMPTY_MAP_SCENE),
      basemapAnchors: { roads: areaLayerAnchor(map), labels: labelLayerAnchor(map) },
    });
    appliedScene.set(map, scene);
  });
}

function getRouteStyleMode(modes: readonly RouteStyleMode[], id: LensId): RouteStyleMode {
  const found = modes.find((mode) => mode.id === id);
  if (found) return found;
  // 軸の非公開等でidのモードが消えていたら先頭へ倒す。選択中の色分けが黙って変わるため警告を残す。
  debugLog(
    "map:route-style-mode",
    `route style mode "${id}" not found, falling back to "${modes[0].id}"`,
    { requestedId: id, availableIds: modes.map((mode) => mode.id) },
    "warn",
  );
  return modes[0];
}
