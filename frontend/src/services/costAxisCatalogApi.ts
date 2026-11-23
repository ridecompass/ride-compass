import { backendApi, getOptions, requestApi } from "@/lib/apiClient";

/** 費用の軸の一覧の、画面での名前（取得の失敗・読み込み中の文が使う）。 */
export const COST_AXIS_CATALOG_LABEL = "負担の種類の一覧";

// 費用の軸の一覧の取得。認可不要の読み取り専用API。管理APIで書いた定義も、この取得だけでフロントへ届く。
export function getCostAxisCatalog() {
  return requestApi(
    (init) => backendApi.GET("/api/cost-axes", init),
    getOptions({
      category: "api:costAxisCatalog",
      errorLabel: COST_AXIS_CATALOG_LABEL,
    }),
  );
}
