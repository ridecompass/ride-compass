"use client";

// 地図の道の線を塗る、道ごとの層の値の取得。viewportをデバウンスしてから、表示中のタイルを1枚ずつ取る
// （`tileQueries.ts`）。道の線の層が1つも出ていない間は取らない。

import { useQueries, type QueryObserverResult } from "@tanstack/react-query";
import { useMemo } from "react";
import { mergeTileValues, NO_VIEWPORT_TILES, tilesCoveringViewport } from "@/features/map/layers/dynamicWayValues";
import { fetchRoadClasses, ROAD_TILE_MAX_ZOOM, ROAD_TILE_MIN_ZOOM } from "@/features/map/regionApi";
import type { RoadClassValues } from "@/features/map/scene/groups/roadLines";
import { tileQueryOptions } from "@/features/map/tileQueries";
import type { MapViewport } from "@/features/map/view/mapLook";
import { MAP_FETCH_DEBOUNCE_MS, useDebouncedValue } from "@/hooks/useDebouncedValue";
import { getQueryClient } from "@/lib/queryClient";

interface RoadClassesFetch {
  /** 届いたタイルの道ごとの層の値。 */
  values: RoadClassValues;
  /** 表示中のタイルのどれかを取っている最中か。 */
  loading: boolean;
  /** 表示中のタイルのどれかの取得が通信失敗したか。 */
  error: boolean;
  /** 上限で画面の端のタイルを取らなかったか。 */
  truncated: boolean;
}

type TileResult = QueryObserverResult<Awaited<ReturnType<typeof fetchRoadClasses>>>;

// 結果が変わらない限り同じ参照を返すよう、まとめ方はモジュールに1つだけ置く（`useQueries`は関数の参照が同じなら
// まとめ直さない）。
function combine(results: TileResult[]): Omit<RoadClassesFetch, "truncated"> {
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
  const { tiles, truncated } = useMemo(
    () =>
      enabled && viewport ? tilesCoveringViewport(viewport, ROAD_TILE_MIN_ZOOM, ROAD_TILE_MAX_ZOOM) : NO_VIEWPORT_TILES,
    [enabled, viewport],
  );
  const fetched = useQueries(
    {
      queries: tiles.map((tile) =>
        tileQueryOptions(
          ["road-classes"],
          generation,
          tile,
          () => fetchRoadClasses(tile.z, tile.x, tile.y),
          (data) => data.error,
        ),
      ),
      combine,
    },
    getQueryClient(),
  );
  return useMemo(() => ({ ...fetched, truncated }), [fetched, truncated]);
}
