import type {
  GenerationConditions,
  RouteCandidate,
  RouteGenerateJobStatusResponse,
  RouteGenerateRequest,
} from "@/types/route";
import { backendApi, getOptions, requestApi } from "@/lib/apiClient";
import { errorMessage } from "@/lib/apiError";
import { debugLog } from "@/lib/debugLog";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

interface GenerateRoutesResult {
  routes: RouteCandidate[];
  conditions: GenerationConditions;
  /** routesが空のときに、backendが返した原因。 */
  noCandidatesReason?: string;
}

/** ルート生成の進捗（待ちか実行中か）。 */
export interface GenerationProgress {
  status: "queued" | "running";
}

// 問い合わせを打ち始める間隔の下限。backendが待たずに返したとき（問い合わせの失敗・待つ上限を知らない版）に、
// これより詰めて打たない。
const POLL_INTERVAL_MS = 1500;
// 1回の問い合わせでbackendに終わるまで待たせる秒
// （docs/modules/frontend/route-settings-and-results.md「生成を待つ時間・投げる回数の根拠」）。
const JOB_WAIT_SECONDS = routeGenerateConfig.job_wait_seconds;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 生成のジョブの状態を1回取る。backendは終わるまで（`JOB_WAIT_SECONDS`まで）待って返す。 */
async function pollGenerationJob(jobId: string): Promise<RouteGenerateJobStatusResponse> {
  return requestApi(
    (init) =>
      backendApi.GET("/api/routes/generate/{job_id}", {
        params: { path: { job_id: jobId }, query: { wait_seconds: JOB_WAIT_SECONDS } },
        ...init,
      }),
    getOptions({ category: "api:route", errorLabel: "ルート生成の状態" }),
  );
}

/** ルート生成はバックグラウンドジョブ化されている。`POST /api/routes/generate`は
 * 即座（数百ms）にjob_idを返すため、`GET /api/routes/generate/{job_id}`で
 * 完了を待つ（backendが終わるまで待って返すので、返ったらすぐ次を問い合わせる）。`onProgress`は
 * 待ち(queued)/実行中(running)の応答のたびに呼ばれる（呼び出し側のUI表示用、省略可）。 */
export async function generateRoutes(
  request: RouteGenerateRequest,
  onProgress?: (progress: GenerationProgress) => void,
): Promise<GenerateRoutesResult> {
  // 文言は失敗したことと次の手に留め、詳細はbackendのdetailに委ねる。
  const { job_id: jobId } = await requestApi(
    (init) => backendApi.POST("/api/routes/generate", { body: request, ...init }),
    {
      category: "api:route",
      messages: {
        failure: "リクエストに失敗しました。時間をおいて再度お試しください",
        parseFailure: "ルート生成の応答の解析に失敗しました",
      },
      requestMeta: { body: request },
    },
  );
  let pollStartedAt = performance.now();

  for (let pollCount = 0; ; pollCount += 1) {
    // 初回と、backendが待ってから返した後は、待たずに問い合わせる。
    if (pollCount > 0) await sleep(Math.max(0, POLL_INTERVAL_MS - (performance.now() - pollStartedAt)));

    let status: RouteGenerateJobStatusResponse;
    pollStartedAt = performance.now();
    try {
      status = await pollGenerationJob(jobId);
    } catch (error) {
      // 失敗は次の問い合わせで取り直す（まだ失敗が決まっていないのでwarn）。
      debugLog("api:route", "ポーリング失敗、リトライします", { jobId, error: errorMessage(error) }, "warn");
      continue;
    }

    if (status.status === "done") {
      const result = status.result;
      debugLog("api:route", `候補 ${result.routes.length}件`, { jobId });
      // 候補0件の原因を残す（サーバーのログを見に行かずに分かるように）。
      if (result.routes.length === 0 && result.no_candidates_reason) {
        debugLog("api:route", result.no_candidates_reason, { jobId }, "warn");
      }
      return {
        routes: result.routes,
        conditions: result.conditions,
        noCandidatesReason: result.no_candidates_reason ?? undefined,
      };
    }
    if (status.status === "failed") {
      throw new Error(status.error);
    }
    onProgress?.({ status: status.status });
  }
}
