"use client";

import { getClientConfig, CLIENT_CONFIG_LABEL } from "@/services/clientConfigApi";
import { retrySharedCatalogFetch, useSharedCatalog } from "@/hooks/useSharedCatalog";
import { clientConfigFromResponse, EMPTY_CLIENT_CONFIG, type ClientConfig } from "@/lib/clientConfig";
import { tileVersionGatedGroupLabels } from "@/lib/mapDisplay/tileVersionGated";
import type { FetchFailure } from "@/types/fetchFailure";
import type { ClientConfigResponse } from "@/types/route";

const CLIENT_CONFIG_QUERY_KEY = ["client-config"] as const;

const FAILED_CONFIG: ClientConfig = { ...EMPTY_CLIENT_CONFIG, failed: true };

/** 画面の設定の取得をやり直す（`failed`状態からの明示的な再試行導線用）。再取得中は`failed`を下ろし、UIが「取得中」へ戻る。 */
export function retryClientConfigFetch(): void {
  retrySharedCatalogFetch(CLIENT_CONFIG_QUERY_KEY);
}

// 道の線の層とタイルの世代は画面の設定で配られるので、取れなければ道の線とタイルの層は描けない。
const UNDRAWABLE_WITHOUT_CONFIG = ["道の線", ...tileVersionGatedGroupLabels()];

const CLIENT_CONFIG_FETCH_FAILURE: FetchFailure = {
  id: "client-config",
  label: CLIENT_CONFIG_LABEL,
  effect: `地図の${UNDRAWABLE_WITHOUT_CONFIG.join("・")}を表示できません。ルートの合成も使えません。`,
  onRetry: retryClientConfigFetch,
};

/** 画面の設定が取れていないことの項目（取れていれば・取得中なら無い）。常設ヘッダーの印が読む。 */
export function clientConfigFetchFailure(config: ClientConfig): FetchFailure | null {
  return config.failed ? CLIENT_CONFIG_FETCH_FAILURE : null;
}

/** 画面の設定の応答から、読み手の用途の形を導いて返す。取得は読み手の間で1つを共有し、形は読み手が決める
 * （1つの機能だけが読む形は、その機能が`select`を持つ）。共有の仕方と`failed`の意味は`useSharedCatalog`。 */
export function useClientConfigSelect<T>(select: (response: ClientConfigResponse) => T): {
  data: T | undefined;
  failed: boolean;
} {
  return useSharedCatalog(CLIENT_CONFIG_QUERY_KEY, getClientConfig, select);
}

/** 画面の設定。届くまで・失敗したときは空の設定を返す（`loaded`・`failed`で見分ける）。 */
export function useClientConfig(): ClientConfig {
  const { data, failed } = useClientConfigSelect(clientConfigFromResponse);
  if (data !== undefined) return data;
  return failed ? FAILED_CONFIG : EMPTY_CLIENT_CONFIG;
}
