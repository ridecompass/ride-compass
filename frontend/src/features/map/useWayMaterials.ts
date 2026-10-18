"use client";

// 地図が塗る軸の、道ごとの材料の取得・状態管理。
// viewportをデバウンスしてから、表示中のタイル範囲ぶんをまとめて取る——パン・ズームのたびに個別の道を
// 都度問い合わせない。取得対象の軸が0件の間はfetchせず、結果も空へ戻す。材料は走行方位・想定速度に依らないので、
// 向き・速度を変えても取り直さない（色は地図が式で求め直す）。
//
// 対象の軸ごとに別インスタンスを持たず、1つのフックが軸の配列を受け取って全軸ぶんを賄う
// （Reactのフック規則により、実行時に増減しうる軸の件数だけフックを呼ぶことはできない）。

import { keepPreviousData, useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { mergeTileValues, tilesCoveringViewport, type TileXY } from "@/features/map/layers/dynamicWayValues";
import type { WayMaterials } from "@/features/map/scene/groups/axisLines";
import type { DedicatedWayValueAxis } from "@/lib/mapDisplay/axisLayers";
import type { MapViewport } from "@/features/map/layers/windLayer";
import { fetchWayMaterials, ROAD_TILE_MAX_ZOOM, ROAD_TILE_MIN_ZOOM } from "@/features/map/regionApi";
import { MAP_FETCH_DEBOUNCE_MS, useDebouncedValue } from "@/hooks/useDebouncedValue";
import { getQueryClient } from "@/lib/queryClient";

interface WayMaterialsFetch {
  /** feature_key→材料（複数タイルを統合済み。鍵は路面タイルの`feature_key`と同じ文字列）。 */
  materials: WayMaterials;
  /** 現在のビューポートぶんのフェッチが進行中か。falseへ戻るまでの間、
   * まだ一度も材料を受け取っていない道は「取得中」、フェッチ完了後になお値を持たない道は
   * 「その範囲に値が無い」と呼び出し側が区別できるようにする。 */
  loading: boolean;
  /** 直近に完了したフェッチで、いずれかのタイルの取得が通信失敗（HTTPエラー・
   * ネットワークエラー）したか。falseは「本当にその範囲に道が無い」場合と区別する
   * （fetchWayMaterialsのerrorをタイル横断でOR集約する）。 */
  error: boolean;
  /** 一度でも取得を試みて完了したか（成否は問わない）。対象軸に含まれていない間はfalseのまま。
   * 「まだ取りに行っていない」と「取得したが値が無かった」を呼び出し側が区別するために使う
   * （`mapLayers.ts: deriveFetchLayerStatus`）。 */
  hasFetched: boolean;
}

const EMPTY_WAY_MATERIALS_FETCH: WayMaterialsFetch = {
  materials: new Map(),
  loading: false,
  error: false,
  hasFetched: false,
};

const EMPTY_RESULTS: ReadonlyMap<string, WayMaterialsFetch> = new Map();

const ALL_AXES_KEY = "way-materials";
const AXIS_KEY = "way-material";

/** 1軸ぶんの取得の入力。 */
interface AxisRequest {
  axisId: string;
  at: Date | undefined;
  tiles: readonly TileXY[];
  /** その軸の1回のフェッチを一意に決める入力（軸id＋その軸へ載せるクエリパラメータ＋対象タイル集合）。 */
  key: string;
}

function requestKey({ axisId, at, tiles }: Omit<AxisRequest, "key">): string {
  const tileKey = tiles.map((tile) => `${tile.z}/${tile.x}/${tile.y}`).join(",");
  return [axisId, at?.toISOString() ?? "", tileKey].join("|");
}

async function fetchAxis(request: AxisRequest): Promise<WayMaterialsFetch> {
  const responses = await Promise.all(
    request.tiles.map((tile) => fetchWayMaterials(request.axisId, tile.z, tile.x, tile.y, request.at)),
  );
  return {
    materials: mergeTileValues(responses.map((response) => response.materials)),
    loading: false,
    error: responses.some((response) => response.error),
    hasFetched: true,
  };
}

/** 全軸ぶんを取る。軸ごとの答えは軸の入力キーでキャッシュに置き、キーが変わっていない軸は取り直さない——時刻に
 * 依存しない軸は時刻が変わってもキーが変わらないため、時刻スライダーの操作で巻き添えの再取得が起きない。失敗を
 * 含む答えは取っておかず、次に全体を取るときに取り直す。 */
async function fetchAllAxes(
  client: QueryClient,
  requests: readonly AxisRequest[],
): Promise<ReadonlyMap<string, WayMaterialsFetch>> {
  const results = await Promise.all(
    requests.map((request) =>
      client.fetchQuery({
        queryKey: [AXIS_KEY, request.key],
        queryFn: () => fetchAxis(request),
        staleTime: (query) => (query.state.data?.error ? 0 : Infinity),
      }),
    ),
  );
  return new Map(requests.map((request, index) => [request.axisId, results[index]]));
}

/** `axes`（材料を取る軸。呼び出し側がuseMemoで安定した参照を渡すこと）について、現在のビューポート（デバウンス済み）を
 * 覆う道路タイル分をまとめて取得し、軸id→結果のMapを返す。取り直している軸は前の材料を残したまま`loading`を立てる。
 *
 * `at`（時刻）は全軸で共有の入力で、実際にリクエストへ載るのはそれを必要とすると宣言した軸（`wayValueConditions`）
 * だけ——載せない入力はキーからも外れるため、時刻を動かしても時刻で変わらない軸は取り直さない。 */
export function useWayMaterials(
  axes: readonly DedicatedWayValueAxis[],
  mapViewport: MapViewport | null,
  at: Date | undefined,
): ReadonlyMap<string, WayMaterialsFetch> {
  const debouncedViewport = useDebouncedValue(mapViewport, MAP_FETCH_DEBOUNCE_MS);
  const client = getQueryClient();

  const tiles = useMemo(
    () => (debouncedViewport ? tilesCoveringViewport(debouncedViewport, ROAD_TILE_MIN_ZOOM, ROAD_TILE_MAX_ZOOM) : []),
    [debouncedViewport],
  );
  const requests: AxisRequest[] =
    tiles.length === 0
      ? []
      : axes.map((axis) => {
          const request = {
            axisId: axis.axisId,
            at: axis.wayValueConditions.includes("at") ? at : undefined,
            tiles,
          };
          return { ...request, key: requestKey(request) };
        });
  const requestsKey = requests.map((request) => request.key).join("\n");

  const { data, isFetching, isPlaceholderData } = useQuery(
    {
      queryKey: [ALL_AXES_KEY, requestsKey],
      queryFn: () => fetchAllAxes(client, requests),
      enabled: requests.length > 0,
      placeholderData: keepPreviousData,
    },
    client,
  );

  // 入力キーが同じなら同じ結果の参照を返す（参照が変わると、受け取る側が同じ値を当て直す）。
  return useMemo(() => {
    if (requests.length === 0) return EMPTY_RESULTS;
    const results = new Map<string, WayMaterialsFetch>();
    for (const request of requests) {
      const current = isPlaceholderData ? undefined : data?.get(request.axisId);
      // 入力の変わっていない軸は、全体の取り直しの間も手元の答えのまま（キャッシュにある）。
      const unchanged = client.getQueryData<WayMaterialsFetch>([AXIS_KEY, request.key]);
      const settled = current ?? (unchanged?.error === false ? unchanged : undefined);
      results.set(
        request.axisId,
        settled ?? { ...(data?.get(request.axisId) ?? EMPTY_WAY_MATERIALS_FETCH), loading: isFetching },
      );
    }
    return results;
    // `requests`は描くたびに作り直す配列で、中身は`requestsKey`で決まる。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestsKey, data, isFetching, isPlaceholderData, client]);
}
