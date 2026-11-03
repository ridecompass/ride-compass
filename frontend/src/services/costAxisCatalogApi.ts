import { backendApi, getOptions, requestApi } from "@/lib/apiClient";
import { API_TIMEOUT_MS } from "@/lib/apiTimeouts";
import type { CostAxisCatalogResponse } from "@/types/route";

/** 費用の軸の定義がまだ無い間の一覧（backendは404で返す）。 */
const NO_COST_AXES: CostAxisCatalogResponse = { axes: [], avoidance_label: "" };

// 費用の軸の一覧の取得。認可不要の読み取り専用API。管理APIで書いた定義も、この取得だけでフロントへ届く。
export function getCostAxisCatalog() {
  return requestApi(
    async (init) => {
      const result = await backendApi.GET("/api/cost-axes", init);
      return result.response.status === 404 ? { data: NO_COST_AXES, response: new Response(null) } : result;
    },
    getOptions({ timeoutMs: API_TIMEOUT_MS.catalog, category: "api:costAxisCatalog", errorLabel: "費用の軸の一覧" }),
  );
}
