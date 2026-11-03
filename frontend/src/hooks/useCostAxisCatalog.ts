"use client";

import { getCostAxisCatalog } from "@/services/costAxisCatalogApi";
import { retrySharedCatalogFetch, useSharedCatalog } from "@/hooks/useSharedCatalog";
import type { FetchFailure } from "@/types/fetchFailure";
import type { CostAxisCatalogResponse } from "@/types/route";

const COST_AXIS_CATALOG_QUERY_KEY = ["cost-axis-catalog"] as const;

type CostAxisEntry = CostAxisCatalogResponse["axes"][number];

/** 費用の軸1本（`GET /api/cost-axes`の1行を画面が読む形へ移したもの）。 */
export interface CostAxis {
  /** 軸id。倍率の辞書のキーで、地図のレンズのidでもある。 */
  axisId: string;
  /** 軸の費目を書く帳簿。 */
  ledger: CostAxisEntry["ledger"];
  label: string;
  description: string;
  iconId: string;
  /** 地図のレンズの段。 */
  lens: CostAxisEntry["lens"];
}

export interface CostAxisCatalog {
  /** 費用の軸（体力の軸、続けて道の負担の軸）。定義がまだ無い間は0件で`loaded`。 */
  axes: readonly CostAxis[];
  /** 代償の内訳の、避け方の倍率で上乗せした秒の行の名前。 */
  avoidanceLabel: string;
  /** 取得が成功したか。falseの間は`axes`が空なので、今の軸と揃うことを要る処理（倍率を送る）はこれで未確定を区別する。 */
  loaded: boolean;
  /** 取得に失敗し、まだ一度も成功していないか（`loaded`と同時にtrueにならない）。 */
  failed: boolean;
}

const EMPTY: CostAxisCatalog = { axes: [], avoidanceLabel: "", loaded: false, failed: false };
const FAILED: CostAxisCatalog = { ...EMPTY, failed: true };

function costAxisCatalogFromResponse(response: CostAxisCatalogResponse | null): CostAxisCatalog {
  if (response === null) return { ...EMPTY, loaded: true };
  return {
    axes: response.axes.map((entry) => ({
      axisId: entry.axis_id,
      ledger: entry.ledger,
      label: entry.label,
      description: entry.description,
      iconId: entry.icon_id,
      lens: entry.lens,
    })),
    avoidanceLabel: response.avoidance_label,
    loaded: true,
    failed: false,
  };
}

/** 費用の軸の一覧の取得をやり直す（`failed`からの再試行）。 */
export function retryCostAxisCatalogFetch(): void {
  retrySharedCatalogFetch(COST_AXIS_CATALOG_QUERY_KEY);
}

const COST_AXIS_CATALOG_FETCH_FAILURE: FetchFailure = {
  id: "cost-axis-catalog",
  label: "費用の軸の一覧",
  effect: "ルートは軸ごとの倍率を変えていても反映できず、標準の倍率で作ります。",
  onRetry: retryCostAxisCatalogFetch,
};

/** 費用の軸の一覧が取れていないことの項目（取れていれば・取得中なら無い）。常設ヘッダーの印と、負担タブの告知が読む。 */
export function costAxisCatalogFetchFailure(catalog: CostAxisCatalog): FetchFailure | null {
  return catalog.failed ? COST_AXIS_CATALOG_FETCH_FAILURE : null;
}

/** 費用の軸の一覧。届くまで・失敗の間は軸0件（`loaded`・`failed`で見分ける）。取得の共有の仕方は`useSharedCatalog`。 */
export function useCostAxisCatalog(): CostAxisCatalog {
  const { data, failed } = useSharedCatalog(
    COST_AXIS_CATALOG_QUERY_KEY,
    getCostAxisCatalog,
    costAxisCatalogFromResponse,
  );
  if (data !== undefined) return data;
  return failed ? FAILED : EMPTY;
}
