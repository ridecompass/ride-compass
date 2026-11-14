import { backendApi, getOptions, requestApi } from "@/lib/apiClient";
import { API_TIMEOUT_MS } from "@/lib/apiTimeouts";
import type { paths } from "@/types/generated/api";

/** 費用の軸の一覧の、画面での名前（取得の失敗・読み込み中の文が使う）。 */
export const COST_AXIS_CATALOG_LABEL = "負担の種類の一覧";

// 費用の軸の一覧の取得。認可不要の読み取り専用API。管理APIで書いた定義も、この取得だけでフロントへ届く。
export function getCostAxisCatalog() {
  return requestApi(
    (init) => backendApi.GET("/api/cost-axes", init),
    getOptions({
      timeoutMs: API_TIMEOUT_MS.catalog,
      category: "api:costAxisCatalog",
      errorLabel: COST_AXIS_CATALOG_LABEL,
    }),
  );
}

/** 地図のレンズの段の境目の目安の要求（つまみと倍率。`lib/costPreference.ts: lensPreferenceQuery`の形）。 */
export type LensEquivalentsQuery = NonNullable<paths["/api/cost-axes/lens-equivalents"]["get"]["parameters"]["query"]>;
/** 軸id→段の境目の目安（`GET /api/cost-axes/lens-equivalents`）。 */
export type LensEquivalentsResponse =
  paths["/api/cost-axes/lens-equivalents"]["get"]["responses"][200]["content"]["application/json"];

/** 段の境目が、利用者の値でどれだけの事実に当たるかの目安。 */
export function getLensEquivalents(query: LensEquivalentsQuery) {
  return requestApi(
    (init) => backendApi.GET("/api/cost-axes/lens-equivalents", { params: { query }, ...init }),
    getOptions({ timeoutMs: API_TIMEOUT_MS.catalog, category: "api:lensEquivalents", errorLabel: "凡例の目安" }),
  );
}
