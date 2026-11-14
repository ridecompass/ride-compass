// ルート生成（`features/route/useRouteGeneration.ts`）を、本物の`useGenerationConditions`と同じ描画で動かす足場
// （呼び出し側と同じく、補正した目的地は条件へ書き戻る）。生成のジョブの応答は網の層で差し替える。
import { act, renderHook } from "@testing-library/react";
import { vi } from "vitest";

import { useGenerationConditions } from "@/features/route/useGenerationConditions";
import { useRouteGeneration } from "@/features/route/useRouteGeneration";
import { serveGenerationJobs } from "@/testing/generationJobs";
import { makeGenerationConditions, makeRouteCandidate } from "@/testing/routeFixtures";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import type { Coordinates, GenerationConditions, RouteCandidate } from "@/types/route";
import { STANDARD_COST_PREFERENCE } from "@/lib/costPreference";

export const ORIGIN: Coordinates = { latitude: 35.68, longitude: 139.76 };
export const A: Coordinates = { latitude: 35.7, longitude: 139.8 };
export const B: Coordinates = { latitude: 35.71, longitude: 139.81 };
export const T1 = new Date("2026-10-04T09:00:00Z");

interface GenerationProps {
  originKnown: boolean;
  departure: { at: Date; pinned: boolean };
  assumedSpeedKmh: number;
  hasRoutes: boolean;
}

export const PROPS: GenerationProps = {
  originKnown: true,
  departure: { at: T1, pinned: false },
  assumedSpeedKmh: 20,
  hasRoutes: true,
};

export function renderGeneration(props: Partial<GenerationProps> = {}) {
  const onGenerated = vi.fn();
  const onOutcome = vi.fn();
  const rendered = renderHook(
    (p: GenerationProps) => {
      const conditions = useGenerationConditions({ onOriginPlace: () => {} });
      const generation = useRouteGeneration({ conditions, origin: ORIGIN, ...p, onGenerated, onOutcome });
      return { conditions, generation };
    },
    { initialProps: { ...PROPS, ...props } },
  );
  return { ...rendered, onGenerated, onOutcome };
}

export type RenderedGeneration = ReturnType<typeof renderGeneration>;

export async function submit({ result }: RenderedGeneration) {
  await act(() => result.current.generation.submit());
}

/** 周回を外して目的地を置く（既定は周回で、周回の間の目的地は送らない）。 */
export function placeDestination({ result }: RenderedGeneration, at: Coordinates) {
  act(() => result.current.conditions.setLoop(false));
  act(() => result.current.conditions.setDestination(at));
}

export function route(id: string, seconds: number | null = null): RouteCandidate {
  return makeRouteCandidate({ id, estimated_duration_seconds: seconds });
}

/** backendが返す生成の条件（`conditions`）。 */
export function used(overrides: Partial<GenerationConditions> = {}): GenerationConditions {
  return makeGenerationConditions({
    latitude: ORIGIN.latitude,
    longitude: ORIGIN.longitude,
    distance_km: 30,
    distance_tolerance_km: 5,
    cost_preference: STANDARD_COST_PREFERENCE,
    max_routes: routeGenerateConfig.default_max_routes,
    start_time: T1.toISOString(),
    assumed_speed_kmh: 20,
    generated_at: "2026-10-04T09:00:30Z",
    ...overrides,
  });
}

/** 生成のジョブの代役。 */
export function serveRouteGeneration() {
  const jobs = serveGenerationJobs();
  return {
    jobs,
    respond(routes: RouteCandidate[], conditions: GenerationConditions = used(), noCandidatesReason?: string) {
      jobs.respond(routes, conditions, noCandidatesReason);
    },
    /** 最後に出された生成の要求の中身。 */
    sentRequest: () => jobs.submitted.at(-1)?.body,
  };
}
