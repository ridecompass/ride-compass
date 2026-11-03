"use client";

import { getAxisCatalog } from "@/services/axisCatalogApi";
import { retrySharedCatalogFetch, useSharedCatalog } from "@/hooks/useSharedCatalog";
import { axisCatalogFromResponse, EMPTY_CATALOG, type AxisCatalog } from "@/lib/axisCatalog";
import { tileVersionGatedGroupLabels } from "@/lib/mapDisplay/tileVersionGated";
import type { FetchFailure } from "@/types/fetchFailure";
import type { AxisCatalogResponse } from "@/types/route";

const AXIS_CATALOG_QUERY_KEY = ["axis-catalog"] as const;

const FAILED_CATALOG: AxisCatalog = { ...EMPTY_CATALOG, failed: true };

/** 軸カタログの取得をやり直す（`failed`状態からの明示的な再試行導線用）。再取得中は`failed`を下ろし、UIが「取得中」へ戻る。 */
export function retryAxisCatalogFetch(): void {
  retrySharedCatalogFetch(AXIS_CATALOG_QUERY_KEY);
}

// 道の線の層そのものが軸カタログで配られるので、道の線は取れなければいつも描けない。
const UNDRAWABLE_WITHOUT_CATALOG = ["道の線", ...tileVersionGatedGroupLabels()];

const AXIS_CATALOG_FETCH_FAILURE: FetchFailure = {
  id: "axis-catalog",
  label: "評価軸の一覧",
  effect: `地図の${UNDRAWABLE_WITHOUT_CATALOG.join("・")}を表示できません。ルートの合成も使えません。`,
  onRetry: retryAxisCatalogFetch,
};

/** 軸カタログが取れていないことの項目（取れていれば・取得中なら無い）。常設ヘッダーの印が読む。 */
export function axisCatalogFetchFailure(catalog: AxisCatalog): FetchFailure | null {
  return catalog.failed ? AXIS_CATALOG_FETCH_FAILURE : null;
}

/** 軸カタログの応答から、読み手の用途の形を導いて返す。取得は読み手の間で1つを共有し、形は読み手が決める
 * （1つの機能だけが読む形は、その機能が`select`を持つ）。共有の仕方と`failed`の意味は`useSharedCatalog`。 */
export function useAxisCatalogSelect<T>(select: (response: AxisCatalogResponse) => T): {
  data: T | undefined;
  failed: boolean;
} {
  return useSharedCatalog(AXIS_CATALOG_QUERY_KEY, getAxisCatalog, select);
}

/** 軸カタログ。届くまで・失敗したときは軸0件のカタログを返す（`loaded`・`failed`で見分ける）。
 * **重みを送るような「今の公開軸と一致していなければならない」処理は`loaded`を確かめる**——届く前の空の一覧で
 * 送ると、公開軸と食い違う重みになる。 */
export function useAxisCatalog(): AxisCatalog {
  const { data, failed } = useAxisCatalogSelect(axisCatalogFromResponse);
  if (data !== undefined) return data;
  return failed ? FAILED_CATALOG : EMPTY_CATALOG;
}
