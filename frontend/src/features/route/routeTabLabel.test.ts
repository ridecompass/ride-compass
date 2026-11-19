// @vitest-environment node
/**
 * `features/route/routeTabLabel.ts`——「ルート結果」の一覧の並び・群・名前。
 * - `routeListEntries`: 最速の印の1本・残りの生成候補（1からの番号）・合成で作ったルート
 *   （「合成N」）の順に、群を付けて置く
 *
 * ここで見ないもの:
 * - 一覧・タブへの描き方（群の印・区切りの線） → `RouteOutcome/RouteOutcome.test.tsx`
 * - 生成した候補をこの並びで結果へ渡すこと → `useRouteGeneration.result.test.ts`
 */
import { describe, expect, it } from "vitest";

import { makeRouteCandidate } from "@/testing/routeFixtures";
import type { RouteCandidate } from "@/types/route";

import { routeListEntries } from "./routeTabLabel";

function route(id: string, seconds: number | null, overrides: Partial<RouteCandidate> = {}) {
  return makeRouteCandidate({ id, direction_label: `${id}の方位`, estimated_duration_seconds: seconds, ...overrides });
}

/** 行を「id:群:名前/名前の列の文字」で並べる。 */
function entriesOf(entries: ReturnType<typeof routeListEntries<RouteCandidate>>) {
  return entries.map((e) => `${e.route.id}:${e.group}:${e.name}/${e.label}`);
}

describe("routeListEntries", () => {
  it("最速の印の1本を印だけの最速として先頭に置いて残りに1から番号を振り、合成は後へ「合成N」で並べる", () => {
    // 印の1本より速く見積もられた候補があっても、最速は印で決まる
    const generated = [route("a", 900), route("b", 600, { is_fastest: true }), route("c", 500)];
    const edits = [
      { route: route("e2", 700), number: 2 },
      { route: route("e1", 650), number: 1 },
    ];
    expect(entriesOf(routeListEntries(generated, edits))).toEqual([
      "b:fastest:最速/",
      "a:generated:1/1",
      "c:generated:2/2",
      "e2:spliced:合成2/2",
      "e1:spliced:合成1/1",
    ]);
  });
});
