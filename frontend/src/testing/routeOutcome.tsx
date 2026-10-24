// 「ルート結果」の中身（`features/route/RouteOutcome/RouteOutcome.tsx`）を描く足場。結果の状態（`useRouteResults`の戻り値）は
// 選んだ候補・編集をそろえて値で組み、操作は記録するだけにする。軸は架空のもの（`axis_a`等）で、軸カタログの応答は
// 使うテストが`CATALOG_RESPONSE`を与える。
import { render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { vi } from "vitest";

import RouteOutcome from "@/features/route/RouteOutcome/RouteOutcome";
import type { RouteResults } from "@/features/route/useRouteResults";
import { catalogEntry, catalogOf, catalogResponse } from "@/testing/catalogAxes";
import { makeRouteCandidate } from "@/testing/routeFixtures";
import type { RouteCandidate } from "@/types/route";

const ENTRIES = [
  catalogEntry({ axis_id: "axis_a", label: "軸A" }),
  catalogEntry({ axis_id: "axis_b", label: "軸B" }),
  catalogEntry({ axis_id: "axis_c", label: "軸C" }),
];
export const CATALOG = catalogOf(ENTRIES);
export const CATALOG_RESPONSE = catalogResponse(ENTRIES);

export function route(id: string, overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return makeRouteCandidate({ id, direction_label: id, ...overrides });
}

export const FAST = route("fast", {
  distance_km: 10,
  estimated_duration_seconds: 1800,
  overall_difficulty: { average: 41.6, load: 416 },
});
export const SLOW = route("slow", { distance_km: 20, estimated_duration_seconds: 2520, overall_difficulty: null });

export function resultsOf(
  state: Partial<
    Pick<RouteResults, "generated" | "edits" | "selectedRouteId" | "reusedRouteId" | "selectedRouteSegment">
  > = {},
): RouteResults {
  const generated = state.generated ?? [];
  const edits = state.edits ?? [];
  const routes = [...generated, ...edits.map((edit) => edit.route)];
  const selectedRouteId = state.selectedRouteId ?? null;
  const selectedCandidate = routes.find((candidate) => candidate.id === selectedRouteId) ?? null;
  const edit = edits.find((item) => item.route.id === selectedRouteId);
  return {
    routes,
    generated,
    edits,
    selectedRouteId,
    reusedRouteId: state.reusedRouteId ?? null,
    selectedCandidate,
    selectedEdit: edit ? { ...edit, origin: routes.find((candidate) => candidate.id === edit.originId) ?? null } : null,
    hasDetail: (selectedCandidate?.segments.length ?? 0) > 0,
    selectedRouteSegment: state.selectedRouteSegment ?? null,
    selectSegment: vi.fn(),
    segmentFocus: null,
    setSegmentOutsideMap: vi.fn(),
    segmentOnMap: { outside: false, onShow: vi.fn() },
    segmentSidePoints: null,
    usedWeights: null,
    replaceWithGenerated: vi.fn(),
    addEdit: vi.fn(),
    clear: vi.fn(),
    selectTab: vi.fn(),
    selectReused: vi.fn(),
  };
}

export type Generation = ComponentProps<typeof RouteOutcome>["generation"];

export function generationOf(overrides: Partial<Generation> = {}): Generation {
  return {
    running: false,
    progressLabel: undefined,
    conditionsDirty: false,
    weightsNotApplied: false,
    destinationCorrected: false,
    ...overrides,
  };
}

export type Splice = ComponentProps<typeof RouteOutcome>["splice"];

export function renderOutcome({
  results = resultsOf(),
  generation = generationOf(),
  splice = { panel: null },
}: {
  results?: RouteResults;
  generation?: Generation;
  splice?: Splice;
} = {}) {
  render(
    <RouteOutcome
      results={results}
      generation={generation}
      splice={splice}
      routeWeights={{}}
      profileLayers={{ ids: ["elevation"], toggle: vi.fn() }}
    />,
  );
  return { results, splice };
}
