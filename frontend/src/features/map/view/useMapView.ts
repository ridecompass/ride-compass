"use client";

/** 地図の見え方（どのレイヤーを出すか・レンズ・凡例で隠した行）の状態と、そこから導く
 * 地図への値・操作部品への値。
 *
 * 画面から受け取るのはルートの文脈・走行条件・生成に使われた重みだけで、軸やレイヤーの種類を
 * 知らない。軸カタログとタイル世代は共有の源泉から読む。
 */
import { useMemo, useState, type ComponentProps } from "react";

import type LensControl from "@/features/map/LensControl/LensControl";
import {
  buildDefaultLayerVisibility,
  deriveFetchLayerStatus,
  tileVersionGatedLayerIds,
  tileZoomTooWideLayerIds,
  type LayerDataStatusByLayer,
  type MapLayerVisibility,
} from "@/features/map/layers/mapLayers";
import { LENS_DIFFICULTY_ID, type LensId } from "@/lib/mapDisplay/routeStyleModes";
import { viewportCenter, type MapViewport } from "@/features/map/view/mapLook";
import type MapOverlayControls from "@/features/map/MapOverlayControls/MapOverlayControls";
import { isLegendFiltered } from "@/features/map/MapOverlayControls/OverlayLayerRow";
import { mapDisplay } from "@/types/generated/mapDisplay";
import { useAxisCatalog } from "@/hooks/useAxisCatalog";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useWayMaterials } from "@/features/map/useWayMaterials";
import { useRoadClasses } from "@/features/map/useRoadClasses";
import { useDynamicWeatherLayers } from "@/features/map/useDynamicWeatherLayers";
import { useStoredBooleanState, useStoredState } from "@/hooks/useStoredState";
import type { Coordinates } from "@/types/route";
import type { RideConditions } from "@/features/map/regionApi";
import { snapDeg } from "@/lib/cardinalLabel";
import type { WayValueCondition } from "@/lib/catalogAxis";
import { useMapAxisCatalog } from "@/features/map/useMapAxisCatalog";
import { initiallyHiddenLegendKeys } from "@/features/map/scene/legends";
import { WAY_BEARING_STEP_DEG } from "@/features/map/mapHeading";

import {
  deserializeHiddenLegendKeys,
  hiddenKeysOf,
  presentHiddenKeys,
  toggleHiddenKey,
  withHiddenKeys,
} from "./legendFilters";
import { isRouteStyleModeId, lensPremises, lensLegend, lensOptions, paintedAxisId } from "./lens";
import type { HiddenLegendKeys, MapLook } from "./mapLook";
import { deserializeLayerVisibility, overlayChips } from "./overlayChips";

/** 凡例のチェックを地図の絞り込みへ反映するまでの遅れ。連続で何行も外す操作を、描き直し
 * 1回へまとめる（チェックの見た目は即座に変わる）。 */
export const LEGEND_FILTER_DEBOUNCE_MS = 400;

const ROUTE_LAYER_ID = "route";
const NO_STORED_VALUES = {};

interface MapViewInputs {
  /** 候補を選んでいるか。 */
  hasSelectedRoute: boolean;
  /** 選択中の候補の区間まで確定しているか（ルート確定後）。 */
  hasDetail: boolean;
  /** 出発時刻と想定速度。専用配信軸の値と気象レイヤーの表示時刻がこれに従う。 */
  ride: { at: Date; speedKmh: number };
  /** 走行中に、地図の向きと想定速度の代わりに使う向きと速さ。走っていなければnull。 */
  riding: { bearingDeg: number; speedKmh: number } | null;
  /** 刻みへ丸めた現在時刻（`useDepartureTime`）。 */
  now: Date;
  /** レンズの選択肢を「未使用」と分ける重み。 */
  routeWeights: Readonly<Record<string, number>>;
}

interface MapViewState {
  look: MapLook;
  lensControl: ComponentProps<typeof LensControl>;
  overlayControls: ComponentProps<typeof MapOverlayControls>;
  /** 周りの道を塗っている軸が使う走る条件（向き・速さ・出発時刻）。地図の右の列の、その条件のボタンに印を付ける。 */
  lensConditions: readonly WayValueCondition[];
  /** 押した人の地図だけを、スタイルから取り直して組み直す。 */
  redrawMap: () => void;
  /** 地図の見えている範囲の真ん中。地図がまだ範囲を知らせていなければnull。 */
  center: Coordinates | null;
  /** 地図が今映している範囲。地図がまだ範囲を知らせていなければnull。 */
  viewport: MapViewport | null;
  /** 地図が今当てている向き（北から時計回りの度）。地図がまだ範囲を知らせていなければ0（北が上）。 */
  bearing: number;
  /** 地図の道の値を取る走る条件。道を押したときの内訳にも同じ値を使う。 */
  wayConditions: RideConditions;
}

export function useMapView({
  hasSelectedRoute,
  hasDetail,
  ride,
  riding,
  now,
  routeWeights,
}: MapViewInputs): MapViewState {
  const catalog = useAxisCatalog();
  const mapCatalog = useMapAxisCatalog();
  // 保存するのは触った層の真偽だけで、既定は層の一覧（道の線の層は軸カタログが届いてから決まる）から重ねる。
  const [storedVisibility, setLayerVisibility] = useStoredState<MapLayerVisibility>(
    "ridecompass:layer-visibility",
    NO_STORED_VALUES,
    { serialize: JSON.stringify, deserialize: deserializeLayerVisibility },
  );
  const layerVisibility = useMemo(
    () => ({ ...buildDefaultLayerVisibility(mapCatalog.layers), ...storedVisibility }),
    [mapCatalog.layers, storedVisibility],
  );
  // 軸を指す保存値はカタログが届いて初めて読めるため、届いた時点で読み直す。
  const [lens, setLens] = useStoredState<LensId>("ridecompass:route-style-mode", LENS_DIFFICULTY_ID, {
    serialize: (value) => value,
    deserialize: (raw) => (isRouteStyleModeId(mapCatalog.routeStyleModes, raw) ? raw : null),
    reloadKey: catalog.loaded,
  });
  const [keepAfterRoute, setKeepAfterRoute] = useStoredBooleanState("ridecompass:lens-keep-after-route", true);
  const [storedHidden, setStoredHidden] = useStoredState<HiddenLegendKeys>(
    "ridecompass:hidden-legend-keys",
    NO_STORED_VALUES,
    { serialize: JSON.stringify, deserialize: deserializeHiddenLegendKeys },
  );
  // 保存値を最初に隠す行の上に重ねる（保存値に無い軸は最初に隠す行のまま）。最初に隠す行は軸カタログが届いてから
  // 決まるので、保存値を読む時点ではなく使う時点で重ねる。
  const initialHidden = useMemo(() => initiallyHiddenLegendKeys(mapCatalog.roadLayers), [mapCatalog.roadLayers]);
  const hidden = useMemo(() => ({ ...initialHidden, ...storedHidden }), [initialHidden, storedHidden]);
  const setHidden = (update: (current: HiddenLegendKeys) => HiddenLegendKeys) =>
    setStoredHidden((prev) => update({ ...initialHidden, ...prev }));
  const [viewport, setViewport] = useState<MapViewport | null>(null);
  const [mapLayerStatus, setMapLayerStatus] = useState<LayerDataStatusByLayer>({});
  const [refreshToken, setRefreshToken] = useState(0);
  const center = useMemo<Coordinates | null>(() => viewport && viewportCenter(viewport), [viewport]);

  // チップ配下の名前付きソースの表示切替は、チップidを凡例の保存先の鍵にする（`scene/legends.ts`）。
  const hiddenWeatherSources = useMemo(
    () => Object.fromEntries(mapDisplay.weatherLayerGroups.map((group) => [group, hiddenKeysOf(hidden, group)])),
    [hidden],
  );
  const weather = useDynamicWeatherLayers({
    visibility: layerVisibility,
    hiddenSources: hiddenWeatherSources,
    mapViewport: viewport,
    at: ride.at,
    now,
  });
  const painted = paintedAxisId(lens, hasDetail, keepAfterRoute);
  // 道ごとの材料は、全道路を塗っている軸の分だけ取る（塗っていない軸の値は地図に出ない。表示中のものだけ叩く）。
  // 式の木の無い軸は周りの道を塗らないので取らない。
  const fetchAxes = useMemo(
    () => mapCatalog.dedicatedAxes.filter((axis) => axis.axisId === painted && axis.paintsSurroundingRoads),
    [mapCatalog.dedicatedAxes, painted],
  );
  // 走っていない間の走る向きは、地図の上の向きそのもの。向きを段に丸めるのは、向きで材料を取り直す軸が、回転や走行中の
  // 細かな向きの揺れのたびに取り直さないため。式の木・材料・区間インスペクタは同じ丸めた向きで値を求める。
  const bearingDeg = snapDeg(riding?.bearingDeg ?? viewport?.bearing ?? 0, WAY_BEARING_STEP_DEG);
  const speedKmh = riding?.speedKmh ?? ride.speedKmh;
  const wayConditions = useMemo(() => ({ bearingDeg, at: ride.at, speedKmh }), [bearingDeg, ride.at, speedKmh]);
  const wayMaterials = useWayMaterials(fetchAxes, viewport, wayConditions);
  const shownRoadLayers = mapCatalog.roadLayers.filter((layer) => layerVisibility[layer.id] === true);
  const roadClasses = useRoadClasses(shownRoadLayers.length > 0, viewport, catalog.roadClasses.generation);
  // 層の値はどの道の線の層も同じ取得から読むので、取得の状態は出ている層のどれにも出す。
  const roadClassStatus = deriveFetchLayerStatus(
    roadClasses.loading,
    roadClasses.error ? "fetch-failed" : null,
    true,
    true,
    roadClasses.truncated,
  );
  const roadLayerStatus = roadClassStatus
    ? Object.fromEntries(shownRoadLayers.map((layer) => [layer.id, roadClassStatus]))
    : {};
  // 式の木の条件の名前（`bearing_deg`・`speed_kmh`）で地図へ渡す。速度が数でない間は値の無いことにする。
  const formulaConditions = useMemo(
    () => ({ bearing_deg: bearingDeg, ...(Number.isFinite(speedKmh) ? { speed_kmh: speedKmh } : {}) }),
    [bearingDeg, speedKmh],
  );
  const debouncedHidden = useDebouncedValue(hidden, LEGEND_FILTER_DEBOUNCE_MS);

  // MapViewはこの参照が変わるたびに地図の中身を組み直すため、中身が変わったときだけ作る。
  const look = useMemo<MapLook>(
    () => ({
      layerVisibility,
      dynamicWeather: weather.dynamicWeather,
      lens,
      paintedAxisId: painted,
      roadClasses,
      wayMaterials,
      wayConditions: formulaConditions,
      hiddenLegendKeys: debouncedHidden,
      refreshToken,
      onViewportChange: setViewport,
      onLayerDataStatusChange: setMapLayerStatus,
    }),
    [
      layerVisibility,
      weather.dynamicWeather,
      lens,
      painted,
      roadClasses,
      wayMaterials,
      formulaConditions,
      debouncedHidden,
      refreshToken,
    ],
  );

  const legend = lensLegend(lens, hasDetail, mapCatalog);
  const lensHidden = presentHiddenKeys(legend, hiddenKeysOf(hidden, lens));
  const lensFetch = wayMaterials.get(lens);
  const chips = overlayChips({
    layers: mapCatalog.layers,
    roadLayers: mapCatalog.roadLayers,
    visibility: layerVisibility,
    hidden,
    dataStatus: { ...mapLayerStatus, ...roadLayerStatus, ...weather.dynamicWeatherDataStatus },
    zoomTooWideLayerIds: viewport ? tileZoomTooWideLayerIds(mapCatalog.layers, viewport.zoom) : [],
    versionMissingLayerIds: mapCatalog.tileVersions ? [] : tileVersionGatedLayerIds(mapCatalog.layers),
    catalogSettled: catalog.loaded || catalog.failed,
  });
  const setShown = (id: string, on: boolean) => setLayerVisibility((prev) => ({ ...prev, [id]: on }));
  const setHiddenFor = (axisId: string, keys: readonly string[]) =>
    setHidden((prev) => withHiddenKeys(prev, axisId, keys));
  const toggleHiddenFor = (axisId: string, key: string) => setHidden((prev) => toggleHiddenKey(prev, axisId, key));

  // 色分けの凡例が隠した段の保存先の鍵（色分けの選択肢）。「表示」の絞り込みの解除は、これ以外の鍵だけを戻す。
  const lensKeys = new Set<string>([...catalog.axes.map((axis) => axis.axisId), LENS_DIFFICULTY_ID]);

  return {
    look,
    lensControl: {
      lens,
      onLensChange: setLens,
      axisOptions: lensOptions(catalog.axes, routeWeights, catalog.axisColors),
      legend,
      hiddenLegendKeys: lensHidden,
      onToggleLegendKey: (key) => toggleHiddenFor(lens, key),
      onSetHiddenLegendKeys: (keys) => setHiddenFor(lens, keys),
      keepAfterRoute,
      onKeepAfterRouteChange: setKeepAfterRoute,
      hasDetail,
      routeHidden: hasSelectedRoute && layerVisibility[ROUTE_LAYER_ID] !== true,
      premises: lensPremises(painted, catalog.axes),
      dataStatus: lensFetch
        ? deriveFetchLayerStatus(
            lensFetch.loading,
            lensFetch.error ? "fetch-failed" : null,
            lensFetch.materials.size > 0,
            lensFetch.hasFetched,
            lensFetch.truncated,
          )
        : undefined,
    },
    overlayControls: {
      layers: chips,
      route: {
        shown: layerVisibility[ROUTE_LAYER_ID] === true,
        selectable: hasSelectedRoute,
        onChange: (on) => setShown(ROUTE_LAYER_ID, on),
      },
      onToggle: setShown,
      onLegendEntryToggle: toggleHiddenFor,
      onLegendAxisSetHidden: setHiddenFor,
      onHideAllLayers: () =>
        setLayerVisibility((prev) => ({
          ...prev,
          ...Object.fromEntries(chips.map((chip) => [chip.id, false])),
        })),
      // 「表示」の絞り込みだけを数え、戻す（色分けの凡例は色分けの中で戻す）。
      anyLegendHidden: chips.some(isLegendFiltered),
      // 最初に隠す行を持つ軸も、空の並びで「出す」と覚える。
      onShowAllLegendRows: () =>
        setHidden((prev) =>
          Object.fromEntries(Object.entries(prev).map(([key, keys]) => [key, lensKeys.has(key) ? keys : []])),
        ),
    },
    lensConditions: catalog.axes.find((axis) => axis.axisId === painted)?.wayValueConditions ?? [],
    redrawMap: () => setRefreshToken((token) => token + 1),
    center,
    viewport,
    bearing: viewport?.bearing ?? 0,
    wayConditions,
  };
}
