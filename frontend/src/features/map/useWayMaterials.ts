"use client";

// 地図が塗る軸の、道ごとの材料の取得・状態管理。
// viewportと走る条件をデバウンスしてから、表示中のタイルを軸ごとに1枚ずつ取る（`tileQueries.ts`）——パン・ズーム・
// 回転のたびに個別の道を都度問い合わせない。取得対象の軸が0件の間はfetchせず、結果も空へ戻す。走る条件は、軸が材料の
// 要求へ載せると宣言したもの（`wayMaterialConditions`）だけを載せ、ほかの条件を変えても取り直さない（色は地図が式で求め直す）。
//
// 対象の軸ごとに別インスタンスを持たず、1つのフックが軸の配列を受け取って全軸ぶんを賄う
// （Reactのフック規則により、実行時に増減しうる軸の件数だけフックを呼ぶことはできない）。

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
  /** feature_key→材料（複数タイルを統合済み。鍵は路面タイルの`feature_key`と同じ文字列）。 */
  materials: WayMaterials;
  /** 表示中のタイルのどれかを取っている最中か。falseへ戻るまでの間、
   * まだ一度も材料を受け取っていない道は「取得中」、フェッチ完了後になお値を持たない道は
   * 「その範囲に値が無い」と呼び出し側が区別できるようにする。 */
  loading: boolean;
  /** 表示中のタイルのどれかの取得が通信失敗（HTTPエラー・ネットワークエラー）したか。falseは「本当にその範囲に
   * 道が無い」場合と区別する。 */
  error: boolean;
  /** 一度でも取得を試みて完了したか（成否は問わない）。対象軸に含まれていない間はfalseのまま。
   * 「まだ取りに行っていない」と「取得したが値が無かった」を呼び出し側が区別するために使う
   * （`mapLayers.ts: deriveFetchLayerStatus`）。 */
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

/** `axes`（材料を取る軸。呼び出し側がuseMemoで安定した参照を渡すこと）について、現在のビューポート（デバウンス済み）を
 * 覆う道路タイルを1枚ずつ取得し、軸id→結果のMapを返す。取り直している軸は前の材料を残したまま`loading`を立てる。
 *
 * `conditions`（走る条件。呼び出し側がuseMemoで安定した参照を渡すこと）は全軸で共有の入力で、実際にリクエストへ
 * 載るのは軸ごとに宣言した名前（`wayMaterialConditions`）だけ——載せない入力は問い合わせの鍵からも外れる。 */
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
