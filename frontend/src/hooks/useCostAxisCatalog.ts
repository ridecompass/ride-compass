"use client";

import { COST_AXIS_CATALOG_LABEL, getCostAxisCatalog } from "@/services/costAxisCatalogApi";
import { retrySharedCatalogFetch, useSharedCatalog } from "@/hooks/useSharedCatalog";
import type { FetchFailure } from "@/types/fetchFailure";
import type { CostAxisCatalogResponse } from "@/types/route";

/** 軸の識別色。色に意味は持たせず、色相環を軸数で等分して表示順に割り当てる（軸数がいくつでも衝突せず、倍率を0にした軸が
 * あっても他の軸の色は動かない）。 */
function axisColorsOf(axes: readonly { readonly axisId: string }[]): Record<string, string> {
  return Object.fromEntries(axes.map((axis, index) => [axis.axisId, `hsl(${(index * 360) / axes.length}, 62%, 55%)`]));
}

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
  /** 地図のレンズの段（境目は1kmあたりの代償の秒。目安は`features/map/useLensEquivalents.ts`が利用者の値で引く）。 */
  lens: CostAxisEntry["lens"];
}

/** 地図のレンズのうち、軸に属さないもの（総合のレンズと、道の値を求める決まり）。総合は軸と同じ見せ方の欄を持つ。 */
export interface CostLensCatalog {
  totalLens: Pick<CostAxis, "axisId" | "label" | "description" | "iconId" | "lens">;
  mapLens: CostAxisCatalogResponse["map_lens"];
}

export interface CostAxisCatalog {
  /** 費用の軸（体力の軸、続けて道のストレスの軸）。届くまで・失敗の間は0件。 */
  axes: readonly CostAxis[];
  /** 軸id→識別色（どの画面でも同じ軸は同じ色）。 */
  axisColors: Readonly<Record<string, string>>;
  /** 代償の内訳の、避け方の倍率で上乗せした秒の行の名前。 */
  avoidanceLabel: string;
  turnLabel: string;
  /** 曲がる所の行の色を借りる軸のid。 */
  turnAxisId: string;
  /** 地図のレンズ。届くまで・失敗の間はnull。 */
  lenses: CostLensCatalog | null;
  /** 取得が成功したか。falseの間は`axes`が空なので、今の軸と揃うことを要る処理（倍率を送る）はこれで未確定を区別する。 */
  loaded: boolean;
  /** 取得に失敗し、まだ一度も成功していないか（`loaded`と同時にtrueにならない）。 */
  failed: boolean;
}

const EMPTY: CostAxisCatalog = {
  axes: [],
  axisColors: {},
  avoidanceLabel: "",
  turnLabel: "",
  turnAxisId: "",
  lenses: null,
  loaded: false,
  failed: false,
};
const FAILED: CostAxisCatalog = { ...EMPTY, failed: true };

export function costAxisCatalogFromResponse(response: CostAxisCatalogResponse): CostAxisCatalog {
  const axes = response.axes.map((entry): CostAxis => ({
    axisId: entry.axis_id,
    ledger: entry.ledger,
    label: entry.label,
    description: entry.description,
    iconId: entry.icon_id,
    lens: entry.lens,
  }));
  return {
    axes,
    axisColors: axisColorsOf(axes),
    avoidanceLabel: response.avoidance_label,
    turnLabel: response.turn_label,
    turnAxisId: response.turn_axis_id,
    lenses: {
      totalLens: {
        axisId: response.total_lens.lens_id,
        label: response.total_lens.label,
        description: response.total_lens.description,
        iconId: response.total_lens.icon_id,
        lens: response.total_lens.lens,
      },
      mapLens: response.map_lens,
    },
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
  label: COST_AXIS_CATALOG_LABEL,
  effect: "負担の種類ごとの倍率を変えていても反映できないため、ルートは標準の倍率で作ります。",
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
