import { adminApiClient, backendApi, getOptions, requestApi } from "@/lib/apiClient";
import { API_TIMEOUT_MS } from "@/lib/apiTimeouts";
import type { components, paths } from "@/types/generated/api";
import type { AxisDefinitionPayload, AxisShape } from "@/types/route";

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

// 軸の定義

export function listAxisDefinitions() {
  return requestApi((init) => adminApiClient.GET("/axis-definitions", init), adminOptions("軸の一覧の取得"));
}

export function createAxisDefinition(payload: AxisDefinitionPayload) {
  return requestApi(
    (init) => adminApiClient.POST("/axis-definitions", { body: payload, ...init }),
    adminOptions("軸の保存", { body: payload }),
  );
}

export function updateAxisDefinition(axisId: string, payload: AxisDefinitionPayload) {
  return requestApi(
    (init) =>
      adminApiClient.PUT("/axis-definitions/{axis_id}", {
        params: { path: { axis_id: axisId } },
        body: payload,
        ...init,
      }),
    adminOptions("軸の保存", { body: payload }),
  );
}

export async function deleteAxisDefinition(axisId: string): Promise<void> {
  await requestApi(
    (init) => adminApiClient.DELETE("/axis-definitions/{axis_id}", { params: { path: { axis_id: axisId } }, ...init }),
    adminOptions("軸の削除"),
  );
}

export function unpublishAxisDefinition(axisId: string) {
  return requestApi(
    (init) =>
      adminApiClient.POST("/axis-definitions/{axis_id}/unpublish", { params: { path: { axis_id: axisId } }, ...init }),
    adminOptions("軸の非公開化"),
  );
}

// 軸の編集中のプレビュー。分布は初回にWayの抽選と材料の組み立てを伴う。点数と地図の段はDBを読まない。

/** 編集中のshapeで、折れ点を通す前の生値がどう分布するか。 */
export function fetchAxisValueDistribution(shape: AxisShape) {
  const body = { shape };
  return requestApi(
    (init) => adminApiClient.POST("/axis-definitions/preview-distribution", { body, ...init }),
    adminOptions("分布の取得", { timeoutMs: API_TIMEOUT_MS.distribution, body }),
  );
}

export type ScoresPreviewRequest = Schemas["ScoresPreviewRequest"];
export type ScoresPreview = Schemas["ScoresPreviewResponse"];

/** 編集中の折れ点で、値がそれぞれ何点になるか。点数はbackendが評価と同じ計算で出す。 */
export function fetchScoresPreview(body: ScoresPreviewRequest) {
  return requestApi(
    (init) => adminApiClient.POST("/axis-definitions/preview-scores", { body, ...init }),
    adminOptions("点数の確認", { body }),
  );
}

export type CalibrationPreviewRequest = Schemas["CalibrationPreviewRequest"];
export type CalibrationPreview = Schemas["CalibrationPreviewResponse"];

/** 較正の画面の下書きの定義で、地図の段（境界は上書きが無ければ折れ点から導いたもの）と、密度の軸か。 */
export function fetchCalibrationPreview(body: CalibrationPreviewRequest) {
  return requestApi(
    (init) => adminApiClient.POST("/axis-definitions/preview-calibration", { body, ...init }),
    adminOptions("地図の段の確認", { body }),
  );
}

export type WayValuesPreviewRequest = Schemas["WayValuesPreviewRequest"];
/** 道の点数を求める下書き（軸と点のつけ方）。 */
export type WayValuesDraft = Pick<WayValuesPreviewRequest, "axis_id" | "shape">;

/** 編集中の折れ点で、1枚のタイルの道（feature_key）それぞれが何点になるか。値は公開中の軸の道の点数の配信と同じ計算で出す。 */
export function fetchWayValuesPreview(body: WayValuesPreviewRequest) {
  return requestApi(
    (init) => adminApiClient.POST("/axis-definitions/preview-way-values", { body, ...init }),
    adminOptions("道の点数の確認", { body }),
  );
}

// 材料

export type MaterialDistribution = Schemas["MaterialDistributionResponse"];

/** 1材料の値が実データでどの範囲に散らばっているか。 */
export function fetchMaterialDistribution(materialId: string) {
  return requestApi(
    (init) =>
      adminApiClient.GET("/material-catalog/{material_id}/distribution", {
        params: { path: { material_id: materialId } },
        ...init,
      }),
    adminOptions("分布の取得", { timeoutMs: API_TIMEOUT_MS.distribution }),
  );
}

export type MaterialValueShares = Schemas["MaterialValueSharesResponse"];

/** 種類・はい/いいえの材料の値ごとに、その値を持つ道の延長の割合。 */
export function fetchMaterialValueShares(materialId: string) {
  return requestApi(
    (init) =>
      adminApiClient.GET("/material-catalog/{material_id}/value-shares", {
        params: { path: { material_id: materialId } },
        ...init,
      }),
    adminOptions("値ごとの延長の取得", { timeoutMs: API_TIMEOUT_MS.distribution }),
  );
}

/** categoricalの材料が実データで取る値の一覧。 */
export function getMaterialValues(materialId: string) {
  return requestApi(
    (init) =>
      adminApiClient.GET("/material-catalog/{material_id}/values", {
        params: { path: { material_id: materialId } },
        ...init,
      }),
    adminOptions("材料の値一覧の取得", { timeoutMs: API_TIMEOUT_MS.catalog }),
  );
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

/** backendへ疎通できるか。画面は「OK/接続できません」の2値しか出さないため失敗の種類は返さないが、中身は
 * `requestApi`がdebugLogへ残す。 */
export async function checkBackendHealth(): Promise<boolean> {
  const failure = "バックエンドへの疎通確認に失敗しました";
  try {
    const data = await requestApi((init) => backendApi.GET("/health", init), {
      timeoutMs: API_TIMEOUT_MS.status,
      category: "api:health",
      messages: { failure, parseFailure: failure },
    });
    return data.status === "ok";
  } catch {
    return false;
  }
}
