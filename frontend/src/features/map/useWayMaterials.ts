"use client";

import { useQueries, type QueryObserverResult } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
  mergeTileValues,
  NO_VIEWPORT_TILES,
  tilesCoveringViewport,
  type TileXY,
} from "@/features/map/layers/dynamicWayValues";
import type { WayMaterials } from "@/features/map/scene/groups/axisLines";
import { tileQueryOptions } from "@/features/map/tileQueries";
import type { MapLens } from "@/lib/mapDisplay/mapLens";
import type { MapViewport } from "@/features/map/view/mapLook";
import {
  fetchLensMaterials,
  ROAD_TILE_MAX_ZOOM,
  ROAD_TILE_MIN_ZOOM,
  type RideConditions,
  type LensMaterialsQuery,
} from "@/features/map/regionApi";
import { MAP_FETCH_DEBOUNCE_MS, useDebouncedValue } from "@/hooks/useDebouncedValue";
import { getQueryClient } from "@/lib/queryClient";
import { lensPreferenceQuery } from "@/lib/costPreference";
import type { CostPreference } from "@/types/route";

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

type TileResult = QueryObserverResult<Awaited<ReturnType<typeof fetchLensMaterials>>>;

/** レンズの材料の要求（問い合わせの鍵にも載せる）と、タイル1枚の取り方。レンズが宣言した条件と、想定速度と利用者の値
 * （生成の要求と同じつまみと倍率）を載せる。 */
function lensMaterials(
  lens: MapLens,
  conditions: RideConditions,
  costPreference: CostPreference,
  totalLensId: string | null,
) {
  const names = lens.materialConditions;
  const query: LensMaterialsQuery = {
    ...(names.includes("at") ? { at: conditions.at.toISOString() } : {}),
    speed_kmh: conditions.speedKmh,
    ...lensPreferenceQuery(costPreference, lens.lensId, lens.lensId === totalLensId),
  };
  return { query, fetch: (tile: TileXY) => fetchLensMaterials(lens.lensId, tile.z, tile.x, tile.y, query) };
}

/** 1つのレンズの、表示中のタイルごとの結果をまとめる。 */
function lensFetch(results: readonly TileResult[], truncated: boolean): WayMaterialsFetch {
  return {
    materials: mergeTileValues(results.flatMap((result) => (result.data ? [result.data.values] : []))),
    loading: results.some((result) => result.isFetching),
    error: results.some((result) => result.data?.error === true),
    hasFetched: results.some((result) => result.isFetched || result.isPlaceholderData),
    truncated,
  };
}

/** 地図が塗るレンズの道ごとの材料を、間引いた表示範囲を覆うタイルごとに取り、レンズid→結果のMapを返す。レンズの件数は
 * 実行時に決まるので、レンズごとにフックを呼ばず配列で受ける。`lenses`と`conditions`は呼び出し側がuseMemoで安定した参照を
 * 渡すこと。要求と問い合わせの鍵へ載せる走る条件は、レンズが宣言した名前（`materialConditions`）と想定速度。利用者の値
 * `costPreference`（生成の要求へ送る形）も載せ、総合のレンズ`totalLensId`だけが全部の軸の倍率を載せる。 */
export function useWayMaterials(
  lenses: readonly MapLens[],
  mapViewport: MapViewport | null,
  conditions: RideConditions,
  costPreference: CostPreference,
  totalLensId: string | null,
): ReadonlyMap<string, WayMaterialsFetch> {
  const debouncedViewport = useDebouncedValue(mapViewport, MAP_FETCH_DEBOUNCE_MS);
  const debouncedConditions = useDebouncedValue(conditions, MAP_FETCH_DEBOUNCE_MS);
  // 段を続けて押しても、押すたびに見えている全部のタイルを取り直さない（中身で比べる——送る形は描くたびに作り直される）。
  const preferenceKey = useDebouncedValue(JSON.stringify(costPreference), MAP_FETCH_DEBOUNCE_MS);
  const debouncedPreference = useMemo(() => JSON.parse(preferenceKey) as CostPreference, [preferenceKey]);

  const { tiles, truncated } = useMemo(
    () =>
      debouncedViewport
        ? tilesCoveringViewport(debouncedViewport, ROAD_TILE_MIN_ZOOM, ROAD_TILE_MAX_ZOOM)
        : NO_VIEWPORT_TILES,
    [debouncedViewport],
  );
  // 問い合わせはレンズの順に、レンズごとにタイルの数ずつ並ぶ。結果が変わらない限り同じ参照を返すよう、まとめ方は並びが
  // 変わるときだけ作り直す（`useQueries`は関数の参照が同じならまとめ直さない）。
  const combine = useCallback(
    (results: TileResult[]) =>
      tiles.length === 0 || lenses.length === 0
        ? EMPTY_RESULTS
        : new Map(
            lenses.map((lens, index) => [
              lens.lensId,
              lensFetch(results.slice(index * tiles.length, (index + 1) * tiles.length), truncated),
            ]),
          ),
    [lenses, tiles.length, truncated],
  );
  return useQueries(
    {
      queries: lenses.flatMap((lens) => {
        const { query, fetch } = lensMaterials(lens, debouncedConditions, debouncedPreference, totalLensId);
        return tiles.map((tile) =>
          tileQueryOptions(
            ["way-material", "lens", lens.lensId],
            query,
            tile,
            () => fetch(tile),
            (data) => data.error,
          ),
        );
      }),
      combine,
    },
    getQueryClient(),
  );
}
