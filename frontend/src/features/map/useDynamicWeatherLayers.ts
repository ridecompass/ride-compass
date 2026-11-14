"use client";

// 動的気象レイヤーの取得・選んだ時刻に描くコマ・地図へ渡す描画内容・チップの取得状態。
// **要素を名指さない**——何を・どこから・どう読み・どのコマを描くかは源泉の宣言
// （`weatherSources.ts: WEATHER_SOURCES`）が持ち、ここは表示中のソースをループして、段の種類
// （配信元のタイル・配信元の地物・MSMの格子点）ごとに1つずつの実装で描画内容を作る。
import { useQueries } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { deriveFetchLayerStatus, type LayerDataStatus, type MapLayerVisibility } from "@/features/map/layers/mapLayers";
import {
  fetchJmaGeojson,
  fetchJmaTargetTimesFile,
  jmaTilePayload,
  type JmaDelivery,
  type JmaFrame,
} from "@/features/map/layers/jmaDelivery";
import {
  deliveriesOf,
  deliveryResultsOf,
  fileStatesOf,
  geojsonKey,
  geojsonStatesOf,
  targetTimesFilesOf,
} from "@/features/map/layers/jmaDeliveryQueries";
import {
  WEATHER_SOURCES,
  gridStageFrames,
  jmaStageFrames,
  readsGrid,
  selectFrame,
  sourceTimeline,
  type GridValue,
  type StageFrameRef,
  type WeatherSource,
} from "@/features/map/layers/weatherSources";
import { precipitationCells } from "@/features/map/layers/precipitationNowcast";
import { windArrows } from "@/features/map/layers/windLayer";
import type { MapViewport } from "@/features/map/view/mapLook";
import {
  isTileRenderKind,
  pointsAtFailedTiles,
  type DynamicWeatherGroupState,
  type DynamicWeatherLayerId,
  type DynamicWeatherRenderPayload,
} from "@/features/map/layers/dynamicWeather";
import { jmaTileFailures, subscribeJmaTileFailures } from "@/features/map/layers/jmaTileProtocol";
import { useWeatherGrid } from "@/features/map/useWeatherGrid";
import { getQueryClient } from "@/lib/queryClient";
import type { MsmGridForecast } from "@/types/weather";

/** 格子の段の描き方。読む値ごとに1つ。 */
const GRID_PAYLOAD: Record<GridValue, (grid: MsmGridForecast, timeIndex: number) => DynamicWeatherRenderPayload> = {
  precipitation: precipitationCells,
  wind: windArrows,
};

const WEATHER_GROUPS: ReadonlySet<DynamicWeatherLayerId> = new Set(WEATHER_SOURCES.map((source) => source.group));

interface UseDynamicWeatherLayersOptions {
  /** 全レイヤーの表示状態（`MapLayerId`→boolean）。**動的気象レイヤーを足してもこの境界は
   * 変わらない**（`MapView`が受け取る`look.layerVisibility`と同じ形、
   * docs/modules/frontend/static-map-layers.md「表示状態の渡し方」）。 */
  visibility: MapLayerVisibility;
  /** チップ配下で非表示に選ばれている名前付きソース（▶パネルの「表示する情報」）。面同士が重なると
   * 混色して危険度を読み取れないため、要素単位で間引けるようにしている。非表示のソースが読む配信は、
   * 同じ配信を読む表示中のソースが無ければ取りに行かない（「表示中のものだけ叩く」方針）。 */
  hiddenSources: Partial<Record<DynamicWeatherLayerId, readonly string[]>>;
  mapViewport: MapViewport | null;
  /** 表示する時刻（出発時刻）と、刻みへ丸めた現在時刻（`useDepartureTime`）。各ソースは
   * `at`に対して源泉の規則でコマを選ぶ（刻みはソースごとに違ってよい）。 */
  at: Date;
  now: Date;
}

interface UseDynamicWeatherLayersResult {
  /** MapViewへそのまま渡す動的気象レイヤーのプロパティ（チップ→名前付きソース→表示・中身）。 */
  dynamicWeather: Partial<Record<DynamicWeatherLayerId, DynamicWeatherGroupState>>;
  /** チップごとのデータ取得状態。MapLibreのソースイベント（`useLayerDataStatus.ts`）は経由しない
   * ——時刻一覧・格子・地物は自前のJSで取りに行き、結果を流し込むだけのため、MapLibre側の
   * ソースイベントはその待ち時間・失敗を観測できない。 */
  dynamicWeatherDataStatus: Partial<Record<DynamicWeatherLayerId, LayerDataStatus>>;
}

export function useDynamicWeatherLayers({
  visibility,
  hiddenSources,
  mapViewport,
  at,
  now,
}: UseDynamicWeatherLayersOptions): UseDynamicWeatherLayersResult {
  const isShown = useCallback(
    (source: WeatherSource) =>
      visibility[source.group] === true && !(hiddenSources[source.group] ?? []).includes(source.source),
    [visibility, hiddenSources],
  );
  const shownSources = useMemo(() => WEATHER_SOURCES.filter(isShown), [isShown]);

  // 表示中のソースが読む配信要素と、その時刻一覧のファイル。取りに行く単位はファイルで、同じファイルを読む要素
  // どうし（キキクルの各要素等）は1つの取得を共有する。
  const deliveries = useMemo(() => deliveriesOf(shownSources), [shownSources]);
  const files = useMemo(() => targetTimesFilesOf(deliveries), [deliveries]);
  const client = getQueryClient();
  const fileStates = useQueries(
    {
      queries: files.map((file) => ({
        queryKey: ["jma-target-times", file.path],
        queryFn: () => fetchJmaTargetTimesFile(file.path, file.label),
        refetchInterval: file.refreshIntervalMs,
      })),
      combine: fileStatesOf,
    },
    client,
  );
  const deliveryResults = useMemo(
    () => deliveryResultsOf(files, fileStates, deliveries),
    [files, fileStates, deliveries],
  );

  // MSMの格子点（風の矢印と降水の升目が共有する1回の取得、`useWeatherGrid.ts`）。
  const usesGrid = shownSources.some(readsGrid);
  const grid = useWeatherGrid(usesGrid, mapViewport);

  // ソースごとの時系列と、選んだ時刻に描くコマ。時系列は時刻を動かしても変わらないので、選ぶのと分けて持つ。
  const timelines = useMemo(
    () =>
      WEATHER_SOURCES.map((source) =>
        sourceTimeline(
          source.stages.map((stage) =>
            stage.origin === "grid"
              ? gridStageFrames(stage, grid.grid, now)
              : jmaStageFrames(stage, deliveryResults.get(stage.delivery.id)?.frames ?? []),
          ),
        ),
      ),
    [deliveryResults, grid.grid, now],
  );
  const selected = useMemo(
    () =>
      new Map<WeatherSource, StageFrameRef | undefined>(
        WEATHER_SOURCES.map((source, index) => [source, selectFrame(source.frameRule, timelines[index], at, now)?.ref]),
      ),
    [timelines, at, now],
  );

  // 配信元のタイルで描かない段（落雷の地点・線状降水帯の雨域）は、配信元が地物をGeoJSONで配る。タイルで描く段は
  // 時刻一覧だけでURLが決まるが、この段は選んだコマが変わるたびに中身を取る。取れた中身を鍵（配信要素と
  // 時刻）で持ち、選んでいるコマの鍵と一致するときだけ描く——コマを動かした後に前のコマの取得が
  // 解決しても、別の時刻の地物を混ぜない。
  const geojsonRequests = useMemo(() => {
    const requests: {
      key: string;
      group: DynamicWeatherLayerId;
      delivery: JmaDelivery;
      frame: JmaFrame;
      label: string;
    }[] = [];
    for (const source of shownSources) {
      const ref = selected.get(source);
      if (ref?.origin !== "jma" || isTileRenderKind(ref.kind)) continue;
      requests.push({
        key: geojsonKey(ref.delivery, ref.frame),
        group: source.group,
        delivery: ref.delivery,
        frame: ref.frame,
        label: source.label,
      });
    }
    return requests;
  }, [shownSources, selected]);
  const geojsonStates = useQueries(
    {
      queries: geojsonRequests.map((request) => ({
        queryKey: ["jma-geojson", request.key],
        queryFn: () => fetchJmaGeojson(request.delivery, request.frame, request.label),
      })),
      combine: geojsonStatesOf,
    },
    client,
  );
  const geojsons = useMemo(
    () =>
      new Map(
        geojsonRequests.flatMap((request, index): [string, GeoJSON.FeatureCollection][] => {
          const geojson = geojsonStates[index]?.geojson;
          return geojson === undefined ? [] : [[request.key, geojson]];
        }),
      ),
    [geojsonRequests, geojsonStates],
  );

  const payloadOf = useCallback(
    (source: WeatherSource): DynamicWeatherRenderPayload | undefined => {
      const ref = selected.get(source);
      if (ref === undefined) return undefined;
      if (ref.origin === "grid") {
        const timeIndex = grid.grid?.times.indexOf(ref.time) ?? -1;
        return timeIndex < 0 ? undefined : GRID_PAYLOAD[ref.value](grid.grid!, timeIndex);
      }
      if (isTileRenderKind(ref.kind)) return jmaTilePayload(ref.kind, ref.delivery, ref.frame);
      const geojson = geojsons.get(geojsonKey(ref.delivery, ref.frame));
      return geojson && { kind: ref.kind, geojson };
    },
    [selected, grid.grid, geojsons],
  );

  const dynamicWeather = useMemo(() => {
    const groups: Partial<Record<DynamicWeatherLayerId, DynamicWeatherGroupState>> = {};
    for (const source of WEATHER_SOURCES) {
      const group = (groups[source.group] ??= {});
      group[source.source] = { visible: isShown(source), payload: payloadOf(source) };
    }
    return groups;
  }, [isShown, payloadOf]);

  // 配信元のタイルが返らない状態は、空タイルで代替するぶんフェッチ側のerrorに現れない
  // （`jmaTileProtocol.ts`）。表示中のソースが描くコマのURLと突き合わせ、取得の失敗に数える。
  const tileFailures = useSyncExternalStore(subscribeJmaTileFailures, jmaTileFailures, jmaTileFailures);

  // チップごとの取得状態。チップは複数の名前付きソースを束ねるため、表示中のソースのどれかが
  // 描けていれば空とせず、どれかの取得が失敗していれば失敗、どれかがまだ取れていなければ読み込み中。
  const dynamicWeatherDataStatus = useMemo(() => {
    const status: Partial<Record<DynamicWeatherLayerId, LayerDataStatus>> = {};
    for (const group of WEATHER_GROUPS) {
      const sources = shownSources.filter((source) => source.group === group);
      const results = deliveriesOf(sources).map(({ delivery }) => deliveryResults.get(delivery.id));
      const groupGeojsons = geojsonStates.filter((_, index) => geojsonRequests[index]?.group === group);
      const onGrid = sources.some(readsGrid);
      const payloads = sources.map((source) => dynamicWeather[source.group]?.[source.source]?.payload);
      const failedTiles = sources.find((_, index) => pointsAtFailedTiles(payloads[index], tileFailures));
      const loading =
        results.some((result) => result === undefined) ||
        groupGeojsons.some((geojson) => geojson.pending) ||
        (onGrid && grid.loading);
      const error =
        results.find((result) => result?.error)?.error ??
        groupGeojsons.find((geojson) => geojson.error)?.error ??
        (onGrid ? grid.error : null) ??
        (failedTiles ? `${failedTiles.label}のタイルの配信が返らない` : null);
      const hasFetched = results.some((result) => result !== undefined) || (onGrid && grid.hasFetched);
      const hasPayload = payloads.some((payload) => payload !== undefined);
      status[group] = deriveFetchLayerStatus(loading, error, hasPayload, hasFetched);
    }
    return status;
  }, [
    shownSources,
    deliveryResults,
    geojsonRequests,
    geojsonStates,
    grid.loading,
    grid.error,
    grid.hasFetched,
    dynamicWeather,
    tileFailures,
  ]);

  return { dynamicWeather, dynamicWeatherDataStatus };
}
