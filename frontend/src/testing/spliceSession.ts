// 区間の乗り換えの編集（`features/route/useSpliceSession.ts`）を、分かれ道が1つずつの網の候補で動かす足場。
// 評価（生成のジョブ）は網の層で差し替え（`testing/generationJobs.ts`）、評価はジョブを作りbackendの回数制限に
// 数えられるので、出した要求を`submitted`で読めるようにする。軸カタログの応答は使うテストが自分で与える。
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";

import type { GenerationInput } from "@/features/route/generationRequest";
import { useSpliceSession } from "@/features/route/useSpliceSession";
import { CLIENT_TUNING_IDS } from "@/lib/axisCatalog";
import { heldReplies } from "@/testing/backendServer";
import { catalogEntry, catalogResponse } from "@/testing/catalogAxes";
import { serveGenerationJobs } from "@/testing/generationJobs";
import { makeGenerationConditions, makeRouteCandidate, routeThrough, type Places } from "@/testing/routeFixtures";
import type { RouteCandidate } from "@/types/route";

export const SPLICE_CATALOG = catalogResponse([catalogEntry({ axis_id: "axis_a", default_weight: 1 })], {
  client_tuning: { [CLIENT_TUNING_IDS.minStretchKm]: 0.1 },
});

// 地点（[経度, 緯度]）。n0→n1→n2→n3が元の道で、n1とn2の間を、nqかnrを通る別の道が結ぶ。
const PLACES: Places = {
  n0: [139.7, 35.6],
  n1: [139.71, 35.6],
  n2: [139.72, 35.6],
  n3: [139.73, 35.6],
  nq: [139.715, 35.61],
  nr: [139.715, 35.605],
};

/** 地点を順に通る目的地の候補。Edgeの境界の位置は座標の位置と食い違う（`testing/routeFixtures.ts: routeThrough`）。 */
function route(id: string, names: readonly string[]): RouteCandidate {
  return makeRouteCandidate({ id, kind: "destination", ...routeThrough(PLACES, names) });
}

/** 地点を順に通る線の座標。 */
export const line = (...names: string[]) => routeThrough(PLACES, names).geometry.coordinates;
/** 地点を順に通るEdge id。 */
const edges = (...names: string[]) => routeThrough(PLACES, names).edge_ids;

// 元: n1→n2を1本で進む。
export const BASE = route("base", ["n0", "n1", "n2", "n3"]);
// 別の道: n1→nq→n2。
export const VIA_Q = route("via-q", ["n0", "n1", "nq", "n2", "n3"]);
// nqまでは同じで、nq→n2をnrを通って進む。nqの道へ乗り換えた後に、次の分かれ道になる。
export const VIA_Q_R = route("via-q-r", ["n0", "n1", "nq", "nr", "n2", "n3"]);
// 評価が返す、どの候補とも違う道。
export const ELSEWHERE = edges("n0", "n1", "nq", "n3");

export const BASIS: GenerationInput = {
  origin: { latitude: 35.6, longitude: 139.7 },
  distanceKm: null,
  maxRoutes: 4,
  assumedSpeedKmh: 22,
  startTime: new Date("2026-10-04T09:00:00Z"),
  startTimePinned: true,
  roadAvoidance: {},
  routePreference: { axis_a: 1 },
  waypoints: [],
  destination: { latitude: 35.6, longitude: 139.73 },
};

// 評価の応答に付く生成の条件（乗り換えは読まない）。
const CONDITIONS = makeGenerationConditions({
  latitude: BASIS.origin.latitude,
  longitude: BASIS.origin.longitude,
  route_preference: { axis_a: 1 },
  penalty_strength: 1,
  max_routes: BASIS.maxRoutes,
  start_time: BASIS.startTime.toISOString(),
  assumed_speed_kmh: BASIS.assumedSpeedKmh,
  destination: BASIS.destination,
  generated_at: "2026-10-04T09:00:30Z",
});

export type SpliceProps = Pick<
  Parameters<typeof useSpliceSession>[0],
  "routes" | "generatedInput" | "hasSelectedRoute"
>;

export const PROPS: SpliceProps = { routes: [BASE, VIA_Q], generatedInput: BASIS, hasSelectedRoute: true };

export function renderSplice(props: Partial<SpliceProps> = {}) {
  const onApplied = vi.fn();
  const rendered = renderHook((p: SpliceProps) => useSpliceSession({ ...p, onApplied }), {
    initialProps: { ...PROPS, ...props },
  });
  return { ...rendered, onApplied };
}

export type RenderedSplice = ReturnType<typeof renderSplice>;

/** 編集を始め、軸カタログ（区間を割る下限）が届いて編集面へ軸が渡るまで待つ。 */
export async function startWithCatalog(rendered: RenderedSplice, routeId = "base") {
  act(() => rendered.result.current.start(routeId));
  await waitFor(() => expect(rendered.result.current.panel?.axes).toHaveLength(1));
}

/** 編集を始め、乗り換え先が地図へ出るまで待つ。 */
export async function startEditing(rendered: RenderedSplice, routeId = "base") {
  act(() => rendered.result.current.start(routeId));
  await waitFor(() => expect(rendered.result.current.map.spliceStretches.length).toBeGreaterThan(0));
}

/** 地図に出ているn番目の乗り換え先をタップする。 */
export function tapStretch(rendered: RenderedSplice, n = 0) {
  const { index } = rendered.result.current.map.spliceStretches[n];
  act(() => rendered.result.current.map.onSpliceStretchSelect(index));
}

export function evaluated(edgeIds: string[], id = "spliced"): RouteCandidate {
  return makeRouteCandidate({ id, kind: "spliced", edge_ids: edgeIds, distance_km: 12.3 });
}

/** 編集面の操作を押し、終わるまで待つ（編集面の型は戻り値を持たないが、実体は評価を待つ）。 */
export async function press(action: (() => unknown) | undefined) {
  await act(async () => {
    await action?.();
  });
}

/** 組み合わせた経路の評価の代役。答えは評価が出される前に積む。 */
export function serveSpliceEvaluations() {
  const jobs = serveGenerationJobs();
  return {
    /** 出された評価の要求。 */
    submitted: jobs.submitted,
    /** 次の評価は`routes`を返す（0本なら、backendが付けた理由`noCandidatesReason`も添えうる）。 */
    respond: (routes: RouteCandidate[], noCandidatesReason?: string) =>
      jobs.respond(routes, CONDITIONS, noCandidatesReason),
    /** 次の評価は失敗する。 */
    fail: () => jobs.fail("リクエストに失敗しました"),
    /** 次の評価は、`resolve`で決着させるまで待つ。 */
    deferred() {
      const job = heldReplies();
      jobs.answerWith(job.reply);
      return {
        resolve: (routes: RouteCandidate[]) =>
          job.answer(0, Response.json({ status: "done", result: { routes, conditions: CONDITIONS } })),
      };
    },
  };
}
