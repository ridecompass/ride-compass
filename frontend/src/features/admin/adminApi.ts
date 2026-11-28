import { translate } from "@/i18n/config";
import { adminApiClient, backendApi, getOptions, requestApi } from "@/lib/apiClient";
import type { components, paths } from "@/types/generated/api";

type Schemas = components["schemas"];

type AdminCallLabel =
  "materialCoverage" | "dbStatus" | "tuningList" | "tuningSave" | "routeProfilesList" | "routeProfilesSave" | "logs";

/** 管理APIの呼び出しの骨格の設定。`call`は失敗の文言の主語の辞書の ID（例: DB状態の取得→「DB状態の取得に失敗しました」）。
 * 本文を送る呼び出しは`body`を渡すと開始のログに載る。 */
function adminOptions(call: AdminCallLabel, { body }: { body?: unknown } = {}) {
  const label = translate(`admin.api.${call}`);
  return {
    category: "api:admin",
    messages: {
      failure: translate("admin.api.failure", { label }),
      parseFailure: translate("admin.api.parseFailure", { label }),
    },
    ...(body !== undefined ? { requestMeta: { body } } : {}),
  };
}

export function getMaterialCoverage() {
  return requestApi((init) => adminApiClient.GET("/material-catalog/coverage", init), adminOptions("materialCoverage"));
}

// データ保守

export function getDbStatus() {
  return requestApi((init) => adminApiClient.GET("/db-status", init), adminOptions("dbStatus"));
}

// 較正値

/** 較正値1件の宣言と、いま効いている値。項目はbackendが宣言から導く。 */
export type TuningParameter = Schemas["TuningParameterView"];

export function listTuningParameters() {
  return requestApi((init) => adminApiClient.GET("/tuning", init), adminOptions("tuningList"));
}

/** 1件を書き換える。 */
export function updateTuningParameter(paramId: string, value: number) {
  const body = { value };
  return requestApi(
    (init) => adminApiClient.PUT("/tuning/{param_id}", { params: { path: { param_id: paramId } }, body, ...init }),
    adminOptions("tuningSave", { body }),
  );
}

// ひな形

/** ひな形の全体（並びは利用者の画面に出す順）。読むのも書くのも全体を1回で。 */
export type RouteProfiles = Schemas["RouteProfiles-Output"];
export type RouteProfile = RouteProfiles["profiles"][number];

export function getRouteProfiles() {
  return requestApi((init) => adminApiClient.GET("/route-profiles", init), adminOptions("routeProfilesList"));
}

/** 全体を入れ替える。今の費用の軸・道の段の行に無い名を指すと、backendが名指して断る。 */
export function replaceRouteProfiles(body: RouteProfiles) {
  return requestApi(
    (init) => adminApiClient.PUT("/route-profiles", { body, ...init }),
    adminOptions("routeProfilesSave", { body }),
  );
}

// ログ

type LogsQuery = NonNullable<paths["/api/admin/debug/logs"]["get"]["parameters"]["query"]>;

/** Python標準loggingのレベル名。正本はbackendで、契約から引く。 */
export type LogLevelName = NonNullable<LogsQuery["min_level"]>;

/** 直近のログ行（プロセス内リングバッファ）。debug_modeがOFFの間もWARNING以上は常に含まれる。 */
export function getRecentLogs(query: LogsQuery) {
  return requestApi((init) => adminApiClient.GET("/debug/logs", { params: { query }, ...init }), adminOptions("logs"));
}

// 稼働状況（認証の要らない口）

export function getDebugStats() {
  return requestApi(
    (init) => backendApi.GET("/api/debug/stats", init),
    getOptions({ category: "api:debug-stats", errorLabel: translate("admin.api.debugStats") }),
  );
}

/** backendの疎通を確かめ、`/health`の応答を返す。疎通できなければ投げる。 */
export function checkBackendHealth() {
  const failure = translate("admin.api.healthFailure");
  return requestApi((init) => backendApi.GET("/health", init), {
    category: "api:health",
    messages: { failure, parseFailure: failure },
  });
}
