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
import type { MapViewport } from "@/features/map/layers/windLayer";
import type MapOverlayControls from "@/features/map/MapOverlayControls/MapOverlayControls";
import { isLegendFiltered } from "@/features/map/MapOverlayControls/OverlayLayerRow";
import { mapDisplay } from "@/types/generated/mapDisplay";
import { useAxisCatalog } from "@/hooks/useAxisCatalog";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useDedicatedWayValues } from "@/features/map/useDedicatedWayValues";
import { useDynamicWeatherLayers } from "@/features/map/useDynamicWeatherLayers";
import { useStoredBooleanState, useStoredState } from "@/hooks/useStoredState";
import type { Coordinates } from "@/types/route";
import type { RideConditions } from "@/features/map/regionApi";
import { travelBearingOf } from "@/features/map/mapHeading";
import type { WayValueCondition } from "@/lib/catalogAxis";
import { useMapAxisCatalog } from "@/features/map/useMapAxisCatalog";
import { initiallyHiddenLegendKeys } from "@/features/map/scene/legends";

import {
  deserializeHiddenLegendKeys,
  hiddenKeysOf,
  presentHiddenKeys,
  toggleHiddenKey,
  withHiddenKeys,
} from "./legendFilters";
import {
  DEFAULT_ROUTE_STYLE_MODE_ID,
  isRouteStyleModeId,
  lensPremises,
  lensLegend,
  lensOptions,
  paintedAxisId,
} from "./lens";
import type { HiddenLegendKeys, MapLook } from "./mapLook";
import { deserializeLayerVisibility, overlayChips } from "./overlayChips";

/** 凡例のチェックを地図の絞り込みへ反映するまでの遅れ。連続で何行も外す操作を、描き直し
 * 1回へまとめる（チェックの見た目は即座に変わる）。 */
export const LEGEND_FILTER_DEBOUNCE_MS = 400;

const ROUTE_LAYER_ID = "route";
const INITIAL_HIDDEN: HiddenLegendKeys = initiallyHiddenLegendKeys();
/** 凡例のどの行も隠していない状態。最初に隠す行を持つ軸も、空の並びで「出す」と覚える。 */
const NONE_HIDDEN: HiddenLegendKeys = Object.fromEntries(Object.keys(INITIAL_HIDDEN).map((axisId) => [axisId, []]));

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
  const [layerVisibility, setLayerVisibility] = useStoredState<MapLayerVisibility>(
    "ridecompass:layer-visibility",
    buildDefaultLayerVisibility(),
    { serialize: JSON.stringify, deserialize: deserializeLayerVisibility },
  );
  // 軸を指す保存値はカタログが届いて初めて読めるため、届いた時点で読み直す。
  const [lens, setLens] = useStoredState<LensId>("ridecompass:route-style-mode", DEFAULT_ROUTE_STYLE_MODE_ID, {
    serialize: (value) => value,
    deserialize: (raw) => (isRouteStyleModeId(mapCatalog.routeStyleModes, raw) ? raw : null),
    reloadKey: catalog.loaded,
  });
  const [keepAfterRoute, setKeepAfterRoute] = useStoredBooleanState("ridecompass:lens-keep-after-route", true);
  const [hidden, setHidden] = useStoredState<HiddenLegendKeys>("ridecompass:hidden-legend-keys", INITIAL_HIDDEN, {
    serialize: JSON.stringify,
    deserialize: (raw) => deserializeHiddenLegendKeys(raw, INITIAL_HIDDEN),
  });
  const [viewport, setViewport] = useState<MapViewport | null>(null);
  const [mapLayerStatus, setMapLayerStatus] = useState<LayerDataStatusByLayer>({});
  const [refreshToken, setRefreshToken] = useState(0);
  const center = useMemo<Coordinates | null>(
    () =>
      viewport && {
        latitude: (viewport.south + viewport.north) / 2,
        longitude: (viewport.west + viewport.east) / 2,
      },
    [viewport],
  );

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
  // 道ごとの値は、全道路を塗っている軸の分だけ取る（塗っていない軸の値は地図に出ない。表示中のものだけ叩く）。
  const fetchAxes = useMemo(
    () => mapCatalog.dedicatedAxes.filter((axis) => axis.axisId === painted),
    [mapCatalog.dedicatedAxes, painted],
  );
  // 走っていない間の走る向きは、地図の上の向きを丸めたもの（丸めた向きが変わらない回転では道の値を取り直さない）。
  const bearingDeg = riding?.bearingDeg ?? travelBearingOf(viewport?.bearing ?? 0);
  const speedKmh = riding?.speedKmh ?? ride.speedKmh;
  const wayConditions = useMemo(() => ({ bearingDeg, at: ride.at, speedKmh }), [bearingDeg, ride.at, speedKmh]);
  const dedicatedWayValues = useDedicatedWayValues(fetchAxes, viewport, bearingDeg, ride.at, speedKmh);
  const debouncedHidden = useDebouncedValue(hidden, LEGEND_FILTER_DEBOUNCE_MS);

  // MapViewはこの参照が変わるたびに地図の中身を組み直すため、中身が変わったときだけ作る。
  const look = useMemo<MapLook>(
    () => ({
      layerVisibility,
      dynamicWeather: weather.dynamicWeather,
      lens,
      paintedAxisId: painted,
      dedicatedWayValues,
      hiddenLegendKeys: debouncedHidden,
      refreshToken,
      onViewportChange: setViewport,
      onLayerDataStatusChange: setMapLayerStatus,
    }),
    [layerVisibility, weather.dynamicWeather, lens, painted, dedicatedWayValues, debouncedHidden, refreshToken],
  );

  const legend = lensLegend(lens, hasDetail, mapCatalog);
  const lensHidden = presentHiddenKeys(legend, hiddenKeysOf(hidden, lens));
  const lensFetch = dedicatedWayValues.get(lens);
  const chips = overlayChips({
    layers: mapCatalog.layers,
    visibility: layerVisibility,
    hidden,
    dataStatus: { ...mapLayerStatus, ...weather.dynamicWeatherDataStatus },
    zoomTooWideLayerIds: viewport ? tileZoomTooWideLayerIds(viewport.zoom) : [],
    versionMissingLayerIds: mapCatalog.tileVersions ? [] : tileVersionGatedLayerIds(),
    catalogSettled: catalog.loaded || catalog.failed,
  });
  const setRouteShown = (on: boolean) => setLayerVisibility((prev) => ({ ...prev, [ROUTE_LAYER_ID]: on }));
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
            lensFetch.values.size > 0,
            lensFetch.hasFetched,
          )
        : undefined,
    },
    overlayControls: {
      layers: chips,
      route: {
        shown: layerVisibility[ROUTE_LAYER_ID] === true,
        selectable: hasSelectedRoute,
        onChange: setRouteShown,
      },
      onToggle: (id, on) => setLayerVisibility((prev) => ({ ...prev, [id]: on })),
      onLegendEntryToggle: toggleHiddenFor,
      onLegendAxisSetHidden: setHiddenFor,
      onHideAllLayers: () =>
        setLayerVisibility((prev) => ({
          ...prev,
          ...Object.fromEntries(chips.map((chip) => [chip.id, false])),
        })),
      // 「表示」の絞り込みだけを数え、戻す（色分けの凡例は色分けの中で戻す）。
      anyLegendHidden: chips.some(isLegendFiltered),
      onShowAllLegendRows: () =>
        setHidden((prev) =>
          Object.fromEntries(
            Object.entries({ ...NONE_HIDDEN, ...prev }).map(([key, keys]) => [key, lensKeys.has(key) ? keys : []]),
          ),
        ),
    },
    lensConditions: catalog.axes.find((axis) => axis.axisId === painted)?.wayValueConditions ?? [],
    redrawMap: () => setRefreshToken((token) => token + 1),
    center,
    bearing: viewport?.bearing ?? 0,
    wayConditions,
  };
}
