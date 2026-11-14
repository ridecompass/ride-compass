"use client";

import { useQuery } from "@tanstack/react-query";
import { getQueryClient } from "@/lib/queryClient";

/** 一覧の取得を、まだ一度も届いていないときだけやり直す（`failed`からの再試行）。取り直している間は`failed`を下ろし、
 * 読み手が「取得中」へ戻る。 */
export function retrySharedCatalogFetch(queryKey: readonly string[]): void {
  const client = getQueryClient();
  if (client.getQueryData(queryKey) !== undefined) return;
  void client.refetchQueries({ queryKey });
}

/** 画面の全体が読む一覧（画面の設定・費用の軸の一覧）の取得。取得は読み手の間で1つを共有し、マウントのたびに取り直す
 * （管理の画面・APIで変えた定義を再デプロイなしに反映する）。一度届いた応答は、後の取得の失敗で巻き戻さない。
 * 応答から読み手の形を`select`（モジュールの関数を渡す——参照が変わるたびに導き直す）で導く。届くまで・失敗の間は
 * `data`が`undefined`で、`failed`は取得を試みて失敗し、まだ一度も成功していないことを表す。 */
export function useSharedCatalog<R, T>(
  queryKey: readonly string[],
  queryFn: () => Promise<R>,
  select: (response: R) => T,
): { data: T | undefined; failed: boolean } {
  const { data, isError, isFetching } = useQuery(
    // 読み手が一時いなくなっても捨てない（捨てると、次にマウントした部品が軸0件から始まる）。
    { queryKey, queryFn, gcTime: Infinity, select },
    getQueryClient(),
  );
  return { data, failed: data === undefined && isError && !isFetching };
}
