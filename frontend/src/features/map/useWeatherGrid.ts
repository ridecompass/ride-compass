"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { OVERVIEW_MIN_ZOOM, overviewBounds } from "@/features/map/MapOverview/overview";
import type { MapViewport } from "@/features/map/view/mapLook";
import type { MsmGridForecast } from "@/types/weather";
import { getMsmGrid, type Bbox } from "@/services/weatherApi";
import { MAP_FETCH_DEBOUNCE_MS, useDebouncedValue } from "@/hooks/useDebouncedValue";
import { getQueryClient } from "@/lib/queryClient";
import { SECOND_MS } from "@/lib/duration";
import { mapDisplay } from "@/types/generated/mapDisplay";
import refreshIntervals from "@/types/generated/refresh-intervals.json";

// 配信元（気象庁MSM）の更新の間隔に合わせる（短くしても新しい値は無く、同じ応答を取り直すだけ）。
const WEATHER_GRID_REFRESH_INTERVAL_MS = refreshIntervals.msm_seconds * SECOND_MS;

// この未満のズームでは格子点を取らない。境は源泉の情報源の宣言が持つ。
const MSM_GRID_MIN_ZOOM = mapDisplay.layerDataSources.find((source) => source.key === "msmGrid")!.minZoom!;

const MSM_GRID_KEY = "msm-grid";

interface UseWeatherGridResult {
  /** 表示範囲（俯瞰図を出すズームでは俯瞰図の範囲も）の中のMSMの格子点の予報。まだ取れていない・取らない間はnull。取ってから時間が経つと先頭の時刻が過去に
   * なる（落とすのは時系列を作る側）。 */
  grid: MsmGridForecast | null;
  /** まだ一度も取り終えていない間の取得中。 */
  loading: boolean;
  error: string | null;
  /** 一度でも取り終えたか（成否は問わない）。取らない間は偽——真のまま残すと、表示を消しただけの状態を
   * 「取りに行った結果、値が無かった」と読まれる（`mapLayers.ts: deriveFetchLayerStatus`）。 */
  hasFetched: boolean;
}

const DISABLED: UseWeatherGridResult = { grid: null, loading: false, error: null, hasFetched: false };

// 俯瞰図を出すズームでは、俯瞰図が映す範囲も覆うように取る（俯瞰図は本体の地図と同じ格子点を描く）。
function gridBbox(viewport: MapViewport): Bbox {
  const box = { minLon: viewport.west, minLat: viewport.south, maxLon: viewport.east, maxLat: viewport.north };
  if (viewport.zoom < OVERVIEW_MIN_ZOOM) return box;
  const overview = overviewBounds(viewport);
  return {
    minLon: Math.min(box.minLon, overview.west),
    minLat: Math.min(box.minLat, overview.south),
    maxLon: Math.max(box.maxLon, overview.east),
    maxLat: Math.max(box.maxLat, overview.north),
  };
}

/** 風の矢印と降水の塗りが共有する、表示範囲の中のMSMの格子点（1回の取得に風と降水が載る）。`enabled`の間、源泉が
 * 宣言する最小のズーム以上でだけ取り、配信元の更新の間隔で取り直す。 */
export function useWeatherGrid(enabled: boolean, mapViewport: MapViewport | null): UseWeatherGridResult {
  const debouncedMapViewport = useDebouncedValue(mapViewport, MAP_FETCH_DEBOUNCE_MS);
  const fetching = enabled && debouncedMapViewport !== null && debouncedMapViewport.zoom >= MSM_GRID_MIN_ZOOM;
  const bbox = fetching ? gridBbox(debouncedMapViewport) : null;
  const query = useQuery(
    {
      queryKey: [MSM_GRID_KEY, bbox],
      queryFn: () => getMsmGrid(bbox!),
      enabled: fetching,
      refetchInterval: WEATHER_GRID_REFRESH_INTERVAL_MS,
      // 範囲を動かして取り直す間は前の範囲の格子点を出したままにする（消してから描き直すと、地図がちらつく）。
      placeholderData: keepPreviousData,
    },
    getQueryClient(),
  );

  if (!fetching) return DISABLED;
  return {
    grid: query.data ?? null,
    loading: query.isLoading,
    error: query.error?.message ?? null,
    hasFetched: query.isFetched,
  };
}
