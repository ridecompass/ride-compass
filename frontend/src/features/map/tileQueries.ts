// 道ごとの値をタイル1枚ずつ取る問い合わせ（道の線の層の値・評価軸の材料・下書きの点数が共有する）。タイルを問い合わせの鍵に
// するので、地図を動かしても前に取ったタイルは取り直さず、新しく入ったタイルだけを取る。

import { queryOptions, type Query, type UseQueryOptions } from "@tanstack/react-query";
import type { TileXY } from "@/features/map/layers/dynamicWayValues";
import { getQueryClient } from "@/lib/queryClient";

/** 同じ`scope`・同じタイルで、別の`input`で取り終えた値のうち一番新しいもの。 */
function latestOtherInput<Data>(
  scope: readonly unknown[],
  tile: TileXY,
  failed: (data: Data) => boolean,
): Data | undefined {
  const tileOf = (query: Query) => query.queryKey.slice(scope.length + 1).join("/");
  const wanted = `${tile.z}/${tile.x}/${tile.y}`;
  const candidates = getQueryClient()
    .getQueryCache()
    .findAll({ queryKey: scope })
    .filter((query) => {
      const data = query.state.data as Data | undefined;
      return tileOf(query) === wanted && data !== undefined && !failed(data);
    });
  if (candidates.length === 0) return undefined;
  const latest = candidates.reduce((a, b) => (b.state.dataUpdatedAt > a.state.dataUpdatedAt ? b : a));
  return latest.state.data as Data;
}

/**
 * タイル1枚の問い合わせ。鍵は`[...scope, input, z, x, y]`で、`input`（走る条件・下書き等）が変わったタイルは取り直す。
 * 取り直す間は、同じ`scope`の同じタイルを前の`input`で取った値を仮に見せる（値の無い道が取得中の色へ戻らない）。
 * `failed`が真を返す値（失敗の印を持つ応答）は取っておかず、次に見えたときに取り直す。
 */
export function tileQueryOptions<Data>(
  scope: readonly unknown[],
  input: unknown,
  tile: TileXY,
  fetchTile: () => Promise<Data>,
  failed: (data: Data) => boolean = () => false,
) {
  // 型の上の`placeholderData`は、値が関数でないこと（`NonFunctionGuard`）を条件の型で求め、型の引数のままでは解けないので、
  // その欄の型へ読み替える。
  const placeholderData = (() => latestOtherInput(scope, tile, failed)) as unknown as UseQueryOptions<
    Data,
    Error,
    Data,
    unknown[]
  >["placeholderData"];
  return queryOptions<Data, Error, Data, unknown[]>({
    queryKey: [...scope, input, tile.z, tile.x, tile.y],
    queryFn: fetchTile,
    staleTime: (query) => (query.state.data !== undefined && failed(query.state.data) ? 0 : Infinity),
    placeholderData,
  });
}
