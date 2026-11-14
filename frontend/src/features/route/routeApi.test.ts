// @vitest-environment node
/**
 * `features/route/routeApi.ts: generateRoutes`——生成のジョブをbackendへ出し、終わるまで状態を問い合わせて結果を返す口。
 * - 出した直後に問い合わせ、backendに終わるまで（生成物`route-generate-config.json: job_wait_seconds`まで）待たせる。
 *   待ってから返ればすぐ次を問い合わせ、待たずに返れば前の問い合わせから間をおく。待ち・実行中の応答のたびに知らせる
 * - 終われば候補・条件・候補0件の理由を返し、失敗ならbackendの文言で投げる
 * - 問い合わせの失敗は取り直す
 *
 * ここで見ないもの:
 * - 失敗の文言の組み立て・通信の失敗の包み直し → `lib/apiClient.test.ts`
 * - 送る値を組み立てること・結果と進み方を画面の状態にすること → `generationRequest.test.ts`・`useRouteGeneration.test.ts`・
 *   `useRouteGeneration.result.test.ts`
 *
 * 差し替えたもの: 網（msw）と時計（`setTimeout`・`performance`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inTurn, onBackend, type SentRequest } from "@/testing/backendServer";
import { makeRouteCandidate } from "@/testing/routeFixtures";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import type { GenerationConditions, RouteGenerateRequest } from "@/types/route";

import { generateRoutes } from "./routeApi";

const REQUEST: RouteGenerateRequest = {
  latitude: 35.68,
  longitude: 139.77,
  distance_km: 40,
  road_avoidance: {},
  max_routes: 3,
  assumed_speed_kmh: 22,
  start_time: "2026-10-04T01:30:00.000Z",
};
const CONDITIONS = { latitude: 35.68, longitude: 139.77, distance_km: 40 } as GenerationConditions;
const JOB_PATH = "/api/routes/generate/job-1";
const WAIT_MS = routeGenerateConfig.job_wait_seconds * 1000;

/** 生成の受け付けにはjob-1を返し、問い合わせには`polls`を順に返す（尽きたら最後のものを返し続ける）。届いた要求を順に積む。
 * `polls`の代わりに応え方を渡すと、問い合わせにはそれで応える。 */
function stubJob(polls: Response[] | ((request: SentRequest) => Promise<Response>)): SentRequest[] {
  const sent: SentRequest[] = [];
  const nextPoll = typeof polls === "function" ? polls : inTurn(...polls);
  onBackend("POST", "/api/routes/generate", (request) => {
    sent.push(request);
    return Response.json({ job_id: "job-1" });
  });
  onBackend("GET", "/api/routes/generate/:jobId", (request) => {
    sent.push(request);
    return nextPoll(request);
  });
  return sent;
}

const pending = (status: "queued" | "running") => Response.json({ status });
const done = (routes = [makeRouteCandidate({ id: "r1" })], noCandidatesReason: string | null = null) =>
  Response.json({
    status: "done",
    result: { routes, conditions: CONDITIONS, no_candidates_reason: noCandidatesReason },
  });

const failure = () => new Response(null, { status: 503 });
const failures = (count: number) => Array.from({ length: count }, failure);

const polled = (sent: SentRequest[]) => sent.filter((request) => request.path === JOB_PATH).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("generateRoutes", () => {
  it("生成をPOSTで出し、そのジョブの状態をGETで問い合わせて、終われば候補と条件を返す", async () => {
    const routes = [makeRouteCandidate({ id: "r1" }), makeRouteCandidate({ id: "r2" })];
    const sent = stubJob([done(routes)]);

    await expect(generateRoutes(REQUEST)).resolves.toEqual({
      routes,
      conditions: CONDITIONS,
      noCandidatesReason: undefined,
    });
    expect(sent).toEqual([
      { method: "POST", path: "/api/routes/generate", query: {}, body: REQUEST },
      {
        method: "GET",
        path: JOB_PATH,
        query: { wait_seconds: String(routeGenerateConfig.job_wait_seconds) },
        body: undefined,
      },
    ]);
  });

  it("候補が0件なら、backendが返した理由を添えて返す", async () => {
    stubJob([done([], "距離の条件に合う周回が見つかりませんでした")]);

    await expect(generateRoutes(REQUEST)).resolves.toEqual({
      routes: [],
      conditions: CONDITIONS,
      noCandidatesReason: "距離の条件に合う周回が見つかりませんでした",
    });
  });

  it("backendが待ってから返せばすぐ次を問い合わせ、待たずに返せば前の問い合わせから1.5秒おく。待ち・実行中の応答のたびに知らせる", async () => {
    // backendの代役: 1回目は待つ上限まで待って実行中、2回目は待たずに実行中、3回目で完了を返す。
    const replies = [
      { afterMs: WAIT_MS, response: pending("running") },
      { afterMs: 0, response: pending("queued") },
      { afterMs: 0, response: done() },
    ];
    const sent = stubJob(async () => {
      const { afterMs, response } = replies.shift()!;
      await new Promise((resolve) => setTimeout(resolve, afterMs));
      return response;
    });
    const onProgress = vi.fn();
    const result = generateRoutes(REQUEST, onProgress);

    await vi.advanceTimersByTimeAsync(WAIT_MS - 1);
    expect(polled(sent)).toBe(1);
    // 待ってから返ったので、間をおかずに次を問い合わせる（1.5秒寝るなら2回目は待つ上限＋1.5秒）。
    await vi.advanceTimersByTimeAsync(100);
    expect(polled(sent)).toBe(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, { status: "running" });

    // 待たずに返ったので、2回目を打ち始めてから1.5秒は次を問い合わせない。
    await vi.advanceTimersByTimeAsync(1300);
    expect(polled(sent)).toBe(2);
    expect(onProgress).toHaveBeenLastCalledWith({ status: "queued" });
    await vi.advanceTimersByTimeAsync(200);
    expect(polled(sent)).toBe(3);

    await expect(result).resolves.toMatchObject({ routes: [expect.objectContaining({ id: "r1" })] });
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("ジョブが失敗したら、backendの文言で投げる", async () => {
    stubJob([Response.json({ status: "failed", error: "ルートの生成に失敗しました" })]);

    await expect(generateRoutes(REQUEST)).rejects.toThrow("ルートの生成に失敗しました");
  });

  it("問い合わせの失敗は取り直す", async () => {
    const sent = stubJob([...failures(2), done()]);
    const result = generateRoutes(REQUEST);

    await vi.advanceTimersByTimeAsync(1500 * 2);
    await expect(result).resolves.toMatchObject({ routes: [expect.objectContaining({ id: "r1" })] });
    expect(polled(sent)).toBe(3);
  });
});
