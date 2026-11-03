"use client";

import { useQuery } from "@tanstack/react-query";
import { getCostAxisCatalog } from "@/services/costAxisCatalogApi";
import { axisColorsOf } from "@/lib/axisCatalog";
import { getQueryClient } from "@/lib/queryClient";
import type { CostAxisCatalogResponse } from "@/types/route";

const COST_AXIS_CATALOG_QUERY_KEY = ["cost-axis-catalog"] as const;

type CostAxisEntry = CostAxisCatalogResponse["axes"][number];

/** 費用の軸1本（`GET /api/cost-axes`の1行を画面が読む形へ移したもの）。 */
interface CostAxis {
  /** 軸id。倍率の辞書のキーで、地図のレンズのidでもある。 */
  axisId: string;
  /** 軸の費目を書く帳簿。 */
  ledger: CostAxisEntry["ledger"];
  label: string;
  description: string;
  iconId: string;
  /** 地図のレンズの段（境目は1kmあたりの代償の秒）。 */
  lens: CostAxisEntry["lens"];
  /** 段の境目の秒が、標準の条件でどれだけの事実に当たるかの目安。 */
  lensEquivalents: CostAxisEntry["lens_equivalents"];
}

/** 地図のレンズのうち、軸に属さないもの（総合のレンズと、道の値を求める決まり）。総合は軸と同じ見せ方の欄を持つ。 */
export interface CostLensCatalog {
  totalLens: Pick<CostAxis, "axisId" | "label" | "description" | "iconId" | "lens">;
  mapLens: CostAxisCatalogResponse["map_lens"];
}

export interface CostAxisCatalog {
  /** 費用の軸（体力の軸、続けて道の負担の軸）。定義がまだ無い間は0件で`loaded`。 */
  axes: readonly CostAxis[];
  /** 軸id→識別色（どの画面でも同じ軸は同じ色）。 */
  axisColors: Readonly<Record<string, string>>;
  /** 代償の内訳の、避け方の倍率で上乗せした秒の行の名前。 */
  avoidanceLabel: string;
  /** 地図のレンズ。定義がまだ無い間・届くまではnull。 */
  lenses: CostLensCatalog | null;
  /** 取得が成功したか。 */
  loaded: boolean;
  /** 取得に失敗し、まだ一度も成功していないか（`loaded`と同時にtrueにならない）。 */
  failed: boolean;
}

const EMPTY: CostAxisCatalog = {
  axes: [],
  axisColors: {},
  avoidanceLabel: "",
  lenses: null,
  loaded: false,
  failed: false,
};
const FAILED: CostAxisCatalog = { ...EMPTY, failed: true };

function costAxisCatalogFromResponse(response: CostAxisCatalogResponse | null): CostAxisCatalog {
  if (response === null) return { ...EMPTY, loaded: true };
  const axes = response.axes.map((entry): CostAxis => ({
    axisId: entry.axis_id,
    ledger: entry.ledger,
    label: entry.label,
    description: entry.description,
    iconId: entry.icon_id,
    lens: entry.lens,
    lensEquivalents: entry.lens_equivalents,
  }));
  return {
    axes,
    axisColors: axisColorsOf(axes),
    avoidanceLabel: response.avoidance_label,
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

/** 費用の軸の一覧。取得は読み手の間で1つを共有し、マウントのたびに取り直す（管理APIで書いた定義を再デプロイなしに
 * 反映する）。一度届いた応答は、後の取得の失敗で巻き戻さない。届くまで・失敗の間は軸0件（`loaded`・`failed`で見分ける）。 */
export function useCostAxisCatalog(): CostAxisCatalog {
  const { data, isError, isFetching } = useQuery(
    // 読み手が一時いなくなっても捨てない（捨てると、次にマウントした部品が軸0件から始まる）。
    {
      queryKey: COST_AXIS_CATALOG_QUERY_KEY,
      queryFn: getCostAxisCatalog,
      gcTime: Infinity,
      select: costAxisCatalogFromResponse,
    },
    getQueryClient(),
  );
  if (data !== undefined) return data;
  return isError && !isFetching ? FAILED : EMPTY;
}
