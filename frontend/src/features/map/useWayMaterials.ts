"use client";

import { useQueries, type QueryObserverResult } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { mergeTileValues, NO_VIEWPORT_TILES, tilesCoveringViewport } from "@/features/map/layers/dynamicWayValues";
import type { WayMaterials } from "@/features/map/scene/groups/axisLines";
import { tileQueryOptions } from "@/features/map/tileQueries";
import type { DedicatedWayValueAxis } from "@/lib/mapDisplay/axisLayers";
import type { MapViewport } from "@/features/map/view/mapLook";
import {
  fetchWayMaterials,
  ROAD_TILE_MAX_ZOOM,
  ROAD_TILE_MIN_ZOOM,
  type RideConditions,
  type WayMaterialsQuery,
} from "@/features/map/regionApi";
import { MAP_FETCH_DEBOUNCE_MS, useDebouncedValue } from "@/hooks/useDebouncedValue";
import { getQueryClient } from "@/lib/queryClient";

interface WayMaterialsFetch {
  /** feature_key→材料（表示中のタイルを統合済み）。 */
  materials: WayMaterials;
  /** 表示中のタイルのどれかを取っている最中か。 */
  loading: boolean;
  /** 表示中のタイルのどれかの取得が通信失敗したか（正常に空を返したタイルは数えない）。 */
  error: boolean;
  /** 一度でも取得を終えたか（成否は問わない）。「まだ取りに行っていない」と「取ったが値が無かった」を分ける。 */
  hasFetched: boolean;
  /** 上限で画面の端のタイルを取らなかったか。 */
  truncated: boolean;
}

const EMPTY_RESULTS: ReadonlyMap<string, WayMaterialsFetch> = new Map();

type TileResult = QueryObserverResult<Awaited<ReturnType<typeof fetchWayMaterials>>>;

/** 軸が材料の要求へ載せると宣言した条件だけの要求。 */
function axisQuery(axis: DedicatedWayValueAxis, conditions: RideConditions): WayMaterialsQuery {
  const names = axis.wayMaterialConditions;
  return {
    ...(names.includes("at") ? { at: conditions.at.toISOString() } : {}),
    ...(names.includes("bearing_deg") ? { bearing_deg: conditions.bearingDeg } : {}),
    ...(names.includes("speed_kmh") ? { speed_kmh: conditions.speedKmh } : {}),
  };
}

/** 1軸の、表示中のタイルごとの結果をまとめる。 */
function axisFetch(results: readonly TileResult[], truncated: boolean): WayMaterialsFetch {
  return {
    materials: mergeTileValues(results.flatMap((result) => (result.data ? [result.data.values] : []))),
    loading: results.some((result) => result.isFetching),
    error: results.some((result) => result.data?.error === true),
    hasFetched: results.some((result) => result.isFetched || result.isPlaceholderData),
    truncated,
  };
}

/** 地図が塗る軸の道ごとの材料を、間引いた表示範囲を覆うタイルごとに取り、軸id→結果のMapを返す。軸の件数は実行時に
 * 増減するので、軸ごとにフックを呼ばず配列で受ける。`axes`と`conditions`は呼び出し側がuseMemoで安定した参照を渡すこと。
 * 要求と問い合わせの鍵へ載せる走る条件は、軸が宣言した名前（`wayMaterialConditions`）だけ。 */
export function useWayMaterials(
  axes: readonly DedicatedWayValueAxis[],
  mapViewport: MapViewport | null,
  conditions: RideConditions,
): ReadonlyMap<string, WayMaterialsFetch> {
  const debouncedViewport = useDebouncedValue(mapViewport, MAP_FETCH_DEBOUNCE_MS);
  const debouncedConditions = useDebouncedValue(conditions, MAP_FETCH_DEBOUNCE_MS);

  const { tiles, truncated } = useMemo(
    () =>
      debouncedViewport
        ? tilesCoveringViewport(debouncedViewport, ROAD_TILE_MIN_ZOOM, ROAD_TILE_MAX_ZOOM)
        : NO_VIEWPORT_TILES,
    [debouncedViewport],
  );
  // 問い合わせは軸の順に、軸ごとにタイルの数ずつ並ぶ。結果が変わらない限り同じ参照を返すよう、まとめ方は並びが
  // 変わるときだけ作り直す（`useQueries`は関数の参照が同じならまとめ直さない）。
  const combine = useCallback(
    (results: TileResult[]) =>
      tiles.length === 0 || axes.length === 0
        ? EMPTY_RESULTS
        : new Map(
            axes.map((axis, index) => [
              axis.axisId,
              axisFetch(results.slice(index * tiles.length, (index + 1) * tiles.length), truncated),
            ]),
          ),
    [axes, tiles.length, truncated],
  );
  return useQueries(
    {
      queries: axes.flatMap((axis) => {
        const query = axisQuery(axis, debouncedConditions);
        return tiles.map((tile) =>
          tileQueryOptions(
            ["way-material", axis.axisId],
            query,
            tile,
            () => fetchWayMaterials(axis.axisId, tile.z, tile.x, tile.y, query),
            (data) => data.error,
          ),
        );
      }),
      combine,
    },
    getQueryClient(),
  );
}
