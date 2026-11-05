import { backendApi, getOptions, requestApi } from "@/lib/apiClient";
import { API_TIMEOUT_MS } from "@/lib/apiTimeouts";

/** 取れなかったときの知らせが名指す、画面の設定の呼び名。 */
export const CLIENT_CONFIG_LABEL = "画面の設定";

/** 画面の設定（較正値・タイルの版・事故の年・道の区分。`GET /api/client-config`）。 */
export function getClientConfig() {
  return requestApi(
    (init) => backendApi.GET("/api/client-config", init),
    getOptions({ timeoutMs: API_TIMEOUT_MS.catalog, category: "api:clientConfig", errorLabel: CLIENT_CONFIG_LABEL }),
  );
}
