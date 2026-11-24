"use client";

/** 地図の見え方（どのレイヤーを出すか・レンズ・凡例で隠した行）の状態と、そこから導く
 * 地図への値・操作部品への値。
 *
 * 画面から受け取るのはルートの文脈・走行条件・利用者の値だけで、レンズやレイヤーの種類を知らない。画面の設定・費用の
 * 軸の一覧は共有の源泉から読む。
 */
import { useMemo, useState, type ComponentProps } from "react";

import type LensControl from "@/features/map/LensControl/LensControl";
import {
  deriveFetchLayerStatus,
  ROAD_LINE_MIN_ZOOM,
  TILE_ZOOM_TOO_WIDE_NOTICE,
  THIN_ROADS_OMITTED_NOTICE,
  tileZoomTooWideLayerIds,
  type LayerDataStatusByLayer,
  type MapLayerVisibility,
} from "@/features/map/layers/mapLayers";
import { UNSELECTED_LENS_ID, type LensId } from "@/lib/mapDisplay/routeStyleModes";
import { viewportCenter, type MapViewport } from "@/features/map/view/mapLook";
import type MapOverlayControls from "@/features/map/MapOverlayControls/MapOverlayControls";
import { isLegendFiltered } from "@/features/map/MapOverlayControls/OverlayLayerRow";
import { mapDisplay } from "@/types/generated/mapDisplay";
import { useClientConfig } from "@/hooks/useClientConfig";
import { useCostAxisCatalog } from "@/hooks/useCostAxisCatalog";
import { costLensOptions } from "@/features/map/costLens";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useWayMaterials } from "@/features/map/useWayMaterials";
import { useDynamicWeatherLayers } from "@/features/map/useDynamicWeatherLayers";
import { windPreviousRunNotice } from "@/lib/previousRun";
import { useStoredState } from "@/hooks/useStoredState";
import type { Coordinates, RoadAvoidanceOverride } from "@/types/route";
import { avoidanceChoiceOf, type RoadTabMap } from "@/lib/roadAvoidance";
import type { MapTheme } from "@/lib/mapTheme";
import { ROAD_SURFACE_ALL_WAYS_MIN_ZOOM, type RideConditions } from "@/features/map/regionApi";
import { snapDeg } from "@/lib/cardinalLabel";
import { countsAxis, DISABLED_LABEL, STANDARD_COST_FACTOR } from "@/lib/costPreference";
import type { WayValueCondition } from "@/lib/mapDisplay/mapLens";
import { useMapCatalog } from "@/features/map/useMapCatalog";
import { initiallyHiddenLegendKeys } from "@/features/map/scene/legends";
import { WAY_BEARING_STEP_DEG } from "@/features/map/mapHeading";

import { hiddenKeysOf, toggleHiddenKey, withHiddenKeys } from "./legendFilters";
import { lensLegend } from "./lens";
import type { HiddenLegendKeys, MapLook } from "./mapLook";
import { overlayChips } from "./overlayChips";
import type { CostPreference } from "@/types/route";
import { useHazardRanges } from "@/features/map/useHazardRanges";
import { DISASTER_LAYER_ID } from "@/features/map/layers/dynamicWeather";

/** 凡例のチェックを地図の絞り込みへ反映するまでの遅れ。連続で何行も外す操作を、描き直し
 * 1回へまとめる（チェックの見た目は即座に変わる）。 */
const LEGEND_FILTER_DEBOUNCE_MS = 400;

const NO_STORED_VALUES = {};
interface MapViewInputs {
  /** 選択中の候補の区間まで確定しているか（ルート確定後）。 */
  hasDetail: boolean;
  /** 出発時刻と想定速度。専用配信軸の値と気象レイヤーの表示時刻がこれに従う。 */
  ride: { at: Date; speedKmh: number };
  /** 走行中に、地図の向きと想定速度の代わりに使う向きと速さ。走っていなければnull。 */
  riding: { bearingDeg: number; speedKmh: number } | null;
  /** 刻みへ丸めた現在時刻（`useDepartureTime`）。 */
  now: Date;
  /** 費用のレンズを塗る利用者のつまみと倍率（生成の要求へ送る形）。ルートを出している間はそのルートを生成したときの値、
   * 無ければ今の設定——ルートの線と周りの道を同じ量で塗る。 */
  costPreference: CostPreference;
  /** 道路タブの今の段（選んだ段だけ。選んでいない行は既定の段）。道路タブを地図で見ている間、地図の道に塗る。 */
  roadAvoidance: RoadAvoidanceOverride;
  /** 道路タブが画面に見えているか（`app/usePagePanels.ts`の`routeSettingsShown`とタブ）。見えていて「地図で見る」がONの間だけ、段を
   * 地図の道に塗る。 */
  roadTabShown: boolean;
}

interface MapViewState {
  look: MapLook;
  lensControl: ComponentProps<typeof LensControl>;
  overlayControls: ComponentProps<typeof MapOverlayControls>;
  /** 周りの道を塗っているレンズが使う走る条件（向き・速さ・出発時刻）。地図の右の列の、その条件のボタンに印を付ける。 */
  lensConditions: readonly WayValueCondition[];
  /** 押した人の地図だけを、スタイルから取り直して組み直す。 */
  redrawMap: () => void;
  roadTabMap: RoadTabMap;
  /** 地図の見えている範囲の真ん中。地図がまだ範囲を知らせていなければnull。 */
  center: Coordinates | null;
  /** 地図が今映している範囲。地図がまだ範囲を知らせていなければnull。 */
  viewport: MapViewport | null;
  /** 地図が今当てている向き（北から時計回りの度）。地図がまだ範囲を知らせていなければ0（北が上）。 */
  bearing: number;
  /** 地図の道の値を取る走る条件。道を押したときの内訳にも同じ値を使う。 */
  wayConditions: RideConditions;
  /** 費用のレンズを塗っている利用者の値（入力の`costPreference`）。道を押したときの費用のレンズの値にも同じ値を渡す。 */
  costPreference: CostPreference;
}

/** レンズ`lensId`が数える負担を塗るか。総合は数える軸が1つでもあるとき（`totalCounted`）、軸はその軸を数えるとき。 */
function lensCounted(
  lensId: string,
  preference: CostPreference,
  totalLensId: string | undefined,
  totalCounted: boolean,
): boolean {
  return lensId === totalLensId ? totalCounted : countsAxis(preference, lensId);
}

export function useMapView({
  hasDetail,
  ride,
  riding,
  now,
  costPreference,
  roadAvoidance,
  roadTabShown,
}: MapViewInputs): MapViewState {
  const config = useClientConfig();
  // 暗い地図は利用者がメニューで選ぶ（いつ暗くするかを自動では決めない）。
  const [mapTheme, setMapTheme] = useStoredState<MapTheme>("ridecompass:map-theme", "地図の明暗", "light");
  const mapCatalog = useMapCatalog(mapTheme);
  const costCatalog = useCostAxisCatalog();
  const lenses = mapCatalog.lenses;
  // 保存するのは触った層の真偽だけで、触っていない層は出さない（最初は何も点いていない）。
  const [layerVisibility, setLayerVisibility] = useStoredState<MapLayerVisibility>(
    "ridecompass:layer-visibility",
    "地図に出す情報",
    NO_STORED_VALUES,
  );
  const totalLens = costCatalog.lenses?.totalLens ?? null;
  // 数える軸が1つも無い間は総合も数えないので、総合を選べず、総合の名前と凡例を出さず、ルートの線も負担で塗らず、選べる負担が
  // 無いことを添える。
  const totalCounted = useMemo(
    () => costCatalog.axes.some((axis) => countsAxis(costPreference, axis.axisId)),
    [costCatalog.axes, costPreference],
  );
  const [storedLens, setLens] = useStoredState<LensId>("ridecompass:route-style-mode", "塗る負担", UNSELECTED_LENS_ID);
  // 選んでいたレンズの軸をあとから数えなくしたら、選んでいない状態として扱う（選びは残し、数え直せばまた塗る）。
  const lens = lensCounted(storedLens, costPreference, totalLens?.axisId, totalCounted)
    ? storedLens
    : UNSELECTED_LENS_ID;
  const [keepSurroundings, setKeepSurroundings] = useStoredState(
    "ridecompass:route-keep-surroundings",
    "ルートの後も周りを出すか",
    false,
  );
  const [storedHidden, setStoredHidden] = useStoredState<HiddenLegendKeys>(
    "ridecompass:hidden-legend-keys",
    "凡例で隠した段",
    NO_STORED_VALUES,
  );
  // 保存値を最初に隠す行の上に重ねる（保存値に無い鍵は最初に隠す行のまま）。最初に隠す行は画面の設定が届いてから
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
  const hazardRanges = useHazardRanges(weather.dynamicWeather[DISASTER_LAYER_ID], viewport);
  // ルートを選んでいる間は、地図全体に出す設定のときだけ道に付く層（周りの道の塗り・点の層）を地図全体に出す。
  const surroundingsShown = !hasDetail || keepSurroundings;
  const painted = surroundingsShown ? lens : null;
  // 道ごとの材料は、全道路を塗っているレンズの分だけ取る（塗っていないレンズの値は地図に出ない。表示中のものだけ叩く）。
  const fetchLenses = useMemo(() => lenses.filter((candidate) => candidate.lensId === painted), [lenses, painted]);
  // 走っていない間の走る向きは、地図の上の向きそのもの。向きを段に丸めるのは、回転や走行中の細かな向きの揺れのたびに式の木を
  // 解き直さないため。式の木と道の窓は同じ丸めた向きで値を求める。
  const bearingDeg = snapDeg(riding?.bearingDeg ?? viewport?.bearing ?? 0, WAY_BEARING_STEP_DEG);
  const speedKmh = riding?.speedKmh ?? ride.speedKmh;
  const wayConditions = useMemo(() => ({ bearingDeg, at: ride.at, speedKmh }), [bearingDeg, ride.at, speedKmh]);
  const wayMaterials = useWayMaterials(fetchLenses, viewport, wayConditions, costPreference, totalLens?.axisId ?? null);
  const [roadTabOnMap, setRoadTabOnMap] = useStoredState("ridecompass:road-tab-on-map", "道路タブを地図で見るか", true);
  // 道路タブを出していて「地図で見る」がONの間だけ、段を地図の道に塗る。段の値は出し入れで作り直さない。
  const roadAvoidanceShown = roadTabShown && roadTabOnMap;
  const avoidanceChoice = useMemo(
    () => avoidanceChoiceOf(config.roadClasses.avoidance, roadAvoidance, mapTheme),
    [config.roadClasses.avoidance, roadAvoidance, mapTheme],
  );
  // 引いた地図では、路面タイルが細い道を描かない（地図に出ない道を「区分の外」と読ませない）。
  const thinRoadsOmitted = viewport !== null && viewport.zoom < ROAD_SURFACE_ALL_WAYS_MIN_ZOOM;
  // 道路タブで塗っている間は、拡大が足りず塗れないこと・細い道を塗らないことを道路タブに出す（道の層を出していないと、地図の上の
  // 行の状態の印が無い）。
  const roadTabMapNotice =
    !roadAvoidanceShown || viewport === null
      ? null
      : ROAD_LINE_MIN_ZOOM !== undefined && viewport.zoom < ROAD_LINE_MIN_ZOOM
        ? TILE_ZOOM_TOO_WIDE_NOTICE
        : thinRoadsOmitted
          ? THIN_ROADS_OMITTED_NOTICE
          : null;
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
      hazardRanges,
      lens,
      costsCounted: totalCounted,
      surroundingsShown,
      roadAvoidance: avoidanceChoice,
      roadAvoidanceShown,
      wayMaterials,
      wayConditions: formulaConditions,
      hiddenLegendKeys: debouncedHidden,
      refreshToken,
      mapTheme,
      onViewportChange: setViewport,
      onLayerDataStatusChange: setMapLayerStatus,
    }),
    [
      layerVisibility,
      weather.dynamicWeather,
      hazardRanges,
      lens,
      totalCounted,
      surroundingsShown,
      avoidanceChoice,
      roadAvoidanceShown,
      wayMaterials,
      formulaConditions,
      debouncedHidden,
      refreshToken,
      mapTheme,
    ],
  );

  const legend = totalCounted ? lensLegend(lens, hasDetail, mapCatalog) : [];
  const lensFetch = wayMaterials.get(lens);
  const chips = overlayChips({
    layers: mapCatalog.layers,
    roadLayers: mapCatalog.roadLayers,
    visibility: layerVisibility,
    hidden,
    dataStatus: { ...mapLayerStatus, ...weather.dynamicWeatherDataStatus },
    caveats: {
      ...(thinRoadsOmitted
        ? Object.fromEntries(mapCatalog.roadLayers.map((layer) => [layer.id, THIN_ROADS_OMITTED_NOTICE]))
        : {}),
      ...weather.dynamicWeatherNotices,
    },
    zoomTooWideLayerIds: viewport ? tileZoomTooWideLayerIds(mapCatalog.layers, viewport.zoom) : [],
  });
  const setShown = (id: string, on: boolean) => setLayerVisibility((prev) => ({ ...prev, [id]: on }));
  const setHiddenFor = (key: string, keys: readonly string[]) => setHidden((prev) => withHiddenKeys(prev, key, keys));
  const toggleHiddenFor = (key: string, rowKey: string) => setHidden((prev) => toggleHiddenKey(prev, key, rowKey));

  return {
    look,
    lensControl: {
      lens,
      onLensChange: setLens,
      // 選べるレンズは、総合と、数える軸（無効の軸は地図のどこにも出さない）。
      axisOptions: costLensOptions(
        lenses.filter((candidate) => lensCounted(candidate.lensId, costPreference, totalLens?.axisId, totalCounted)),
      ),
      totalLabel: totalCounted ? (totalLens?.label ?? null) : null,
      legend,
      hasDetail,
      caveat:
        [
          // 段の名前の事実は、標準の負担の割合で求めたもの。軸のレンズは割合を変えると同じ事実の道が別の段で塗られる。
          painted !== null &&
          painted !== totalLens?.axisId &&
          (costPreference.strength !== STANDARD_COST_FACTOR ||
            (costPreference.multipliers[painted] ?? STANDARD_COST_FACTOR) !== STANDARD_COST_FACTOR)
            ? "凡例の事実は標準の負担の割合での値です。いまは「負担」タブで割合を変えているので、色はその割合で塗っています。"
            : null,
          windPreviousRunNotice(lensFetch?.windPreviousRunFrom),
        ]
          .filter((line) => line !== null)
          .join(" ") || null,
      catalogNotice: !costCatalog.loaded
        ? costCatalog.failed
          ? "負担の種類の一覧を取得できないため、塗る負担を選べません。"
          : "負担の種類の一覧を読み込んでいます。"
        : totalCounted
          ? null
          : `「負担」タブの全体か全部の種類が${DISABLED_LABEL}のため、塗れる負担はありません。`,
      dataStatus: lensFetch
        ? deriveFetchLayerStatus(
            lensFetch.loading,
            lensFetch.error,
            lensFetch.materials.size > 0,
            lensFetch.hasFetched,
            lensFetch.truncated,
          )
        : undefined,
    },
    overlayControls: {
      layers: chips,
      range: {
        routeOnly: !surroundingsShown,
        selectable: hasDetail,
        onChange: (routeOnly) => setKeepSurroundings(!routeOnly),
      },
      mapTheme: { value: mapTheme, onChange: setMapTheme },
      onToggle: setShown,
      onLegendEntryToggle: toggleHiddenFor,
      onLegendAxisSetHidden: setHiddenFor,
      onHideAllLayers: () =>
        setLayerVisibility((prev) => ({
          ...prev,
          ...Object.fromEntries(chips.map((chip) => [chip.id, false])),
        })),
      anyLegendHidden: chips.some(isLegendFiltered),
      // 最初に隠す行を持つ層も、空の並びで「出す」と覚える。
      onShowAllLegendRows: () => setHidden((prev) => Object.fromEntries(Object.keys(prev).map((key) => [key, []]))),
    },
    lensConditions: lenses.find((candidate) => candidate.lensId === painted)?.conditions ?? [],
    redrawMap: () => setRefreshToken((token) => token + 1),
    roadTabMap: { on: roadTabOnMap, onChange: setRoadTabOnMap, notice: roadTabMapNotice },
    center,
    viewport,
    bearing: viewport?.bearing ?? 0,
    wayConditions,
    costPreference,
  };
}
