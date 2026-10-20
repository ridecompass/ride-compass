"use client";

// 地図の道の線を塗る、道ごとの層の値の取得。viewportをデバウンスしてから、表示中のタイルを1枚ずつ取る——タイルを
// 問い合わせの鍵にするので、地図を動かしても前に取ったタイルは取り直さず、新しく入ったタイルだけを取る。
// 道の線の層が1つも出ていない間は取らない。

import { queryOptions, useQueries, type QueryObserverResult } from "@tanstack/react-query";
import { useMemo } from "react";
import { mergeTileValues, tilesCoveringViewport } from "@/features/map/layers/dynamicWayValues";
import { fetchRoadClasses, ROAD_TILE_MAX_ZOOM, ROAD_TILE_MIN_ZOOM } from "@/features/map/regionApi";
import type { RoadClassValues } from "@/features/map/scene/groups/roadLines";
import type { MapViewport } from "@/features/map/view/mapLook";
import { MAP_FETCH_DEBOUNCE_MS, useDebouncedValue } from "@/hooks/useDebouncedValue";
import { getQueryClient } from "@/lib/queryClient";

export interface RoadClassesFetch {
  /** 届いたタイルの道ごとの層の値。 */
  values: RoadClassValues;
  /** 表示中のタイルのどれかを取っている最中か。 */
  loading: boolean;
  /** 表示中のタイルのどれかの取得が通信失敗したか。 */
  error: boolean;
}

type TileResult = QueryObserverResult<Awaited<ReturnType<typeof fetchRoadClasses>>>;

// 結果が変わらない限り同じ参照を返すよう、まとめ方はモジュールに1つだけ置く（`useQueries`は関数の参照が同じなら
// まとめ直さない）。
function combine(results: TileResult[]): RoadClassesFetch {
  return {
    values: mergeTileValues(results.flatMap((result) => (result.data ? [result.data.values] : []))),
    loading: results.some((result) => result.isFetching),
    error: results.some((result) => result.data?.error === true),
  };
}

/** `generation`（軸カタログの区分の指紋）が替われば取り直す。 */
export function useRoadClasses(
  enabled: boolean,
  mapViewport: MapViewport | null,
  generation: string,
): RoadClassesFetch {
  const viewport = useDebouncedValue(mapViewport, MAP_FETCH_DEBOUNCE_MS);
  const tiles = useMemo(
    () => (enabled && viewport ? tilesCoveringViewport(viewport, ROAD_TILE_MIN_ZOOM, ROAD_TILE_MAX_ZOOM) : []),
    [enabled, viewport],
  );
  return useQueries(
    {
      queries: tiles.map((tile) =>
        queryOptions({
          queryKey: ["road-classes", generation, tile.z, tile.x, tile.y],
          queryFn: () => fetchRoadClasses(tile.z, tile.x, tile.y),
          // 失敗したタイルは取っておかず、次に見えたときに取り直す。
          staleTime: (query) => (query.state.data?.error ? 0 : Infinity),
        }),
      ),
      combine,
    },
    getQueryClient(),
  );
}
