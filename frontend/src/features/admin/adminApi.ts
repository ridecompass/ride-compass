import { adminApiClient, backendApi, getOptions, requestApi } from "@/lib/apiClient";
import { API_TIMEOUT_MS } from "@/lib/apiTimeouts";
import type { components, paths } from "@/types/generated/api";

type Schemas = components["schemas"];

/** 管理APIの呼び出しの骨格の設定。`label`は失敗の文言の主語（例: "DB状態の取得"→「DB状態の取得に失敗しました」）。
 * 本文を送る呼び出しは`body`を渡すと開始のログに載る。 */
function adminOptions(
  label: string,
  { timeoutMs = API_TIMEOUT_MS.default, body }: { timeoutMs?: number; body?: unknown } = {},
) {
  return {
    timeoutMs,
    category: "api:admin",
    messages: { failure: `${label}に失敗しました`, parseFailure: `${label}の結果を解析できませんでした` },
    ...(body !== undefined ? { requestMeta: { body } } : {}),
  };
}

export function getMaterialCoverage() {
  return requestApi(
    (init) => adminApiClient.GET("/material-catalog/coverage", init),
    adminOptions("材料の欠損割合の取得", { timeoutMs: API_TIMEOUT_MS.heavyAdmin }),
  );
}

// データ保守

export function getDerivedDataFreshness() {
  return requestApi(
    (init) => adminApiClient.GET("/derived-data/freshness", init),
    adminOptions("派生データ鮮度台帳の取得", { timeoutMs: API_TIMEOUT_MS.heavyAdmin }),
  );
}

export function getDbStatus() {
  return requestApi(
    (init) => adminApiClient.GET("/db-status", init),
    adminOptions("DB状態の取得", { timeoutMs: API_TIMEOUT_MS.heavyAdmin }),
  );
}

export async function refreshTileCache(): Promise<void> {
  await requestApi((init) => adminApiClient.POST("/basemap/refresh", init), adminOptions("タイルキャッシュの消去"));
}

// 較正値

/** 較正値1件の宣言と、いま効いている値。項目はbackendが宣言から導く。 */
export type TuningParameter = Schemas["TuningParameterView"];

export function listTuningParameters() {
  return requestApi((init) => adminApiClient.GET("/tuning", init), adminOptions("較正値の取得"));
}

/** 1件を書き換える。`value`にnullを渡すと既定へ戻す。 */
export function updateTuningParameter(paramId: string, value: number | null) {
  const body = { value };
  return requestApi(
    (init) => adminApiClient.PUT("/tuning/{param_id}", { params: { path: { param_id: paramId } }, body, ...init }),
    adminOptions("較正値の保存", { body }),
  );
}

// ログ

type LogsQuery = NonNullable<paths["/api/admin/debug/logs"]["get"]["parameters"]["query"]>;

/** Python標準loggingのレベル名。正本はbackendで、契約から引く。 */
export type LogLevelName = NonNullable<LogsQuery["min_level"]>;

/** 直近のログ行（プロセス内リングバッファ）。debug_modeがOFFの間もWARNING以上は常に含まれる。 */
export function getRecentLogs(query: LogsQuery) {
  return requestApi(
    (init) => adminApiClient.GET("/debug/logs", { params: { query }, ...init }),
    adminOptions("ログの取得"),
  );
}

// 稼働状況（認証の要らない口）

export function getDebugStats() {
  return requestApi(
    (init) => backendApi.GET("/api/debug/stats", init),
    getOptions({ timeoutMs: API_TIMEOUT_MS.status, category: "api:debug-stats", errorLabel: "システム状況" }),
  );
}

/** backendの疎通を確かめ、`/health`の応答を返す。疎通できなければ投げる。 */
export function checkBackendHealth() {
  const failure = "バックエンドへの疎通確認に失敗しました";
  return requestApi((init) => backendApi.GET("/health", init), {
    timeoutMs: API_TIMEOUT_MS.status,
    category: "api:health",
    messages: { failure, parseFailure: failure },
  });
}
