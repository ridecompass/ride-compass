/**
 * 区間の乗り換えの編集（`useSpliceSession.ts`）の入口と編集——候補（周回も目的地ルートも）が2本以上あり、候補を選んでいて、
 * 区間を割る下限を引けるときだけ始められる。始めると元の候補を編集面と地図（いま作っているルート）へ渡し、他の候補が別の道を
 * 通る区間を乗り換え先として地図へ出す。乗り換え・1つ戻す・全部戻す・やめるができる。編集は始めたときの生成に結びつき、
 * 抜けると中身ごと消える。
 *
 * ここで見ないもの:
 * - 組み合わせた経路の評価（同じ組み合わせは投げ直さない・既にある候補と同じ道・待つ間の作り直し） → `useSpliceSession.preview.test.ts`
 * - 「作成」で作った経路か同じ道の既存の候補を渡して編集を終えること → `useSpliceSession.apply.test.ts`
 * - 乗り換え先の求め方の細部（区間の割り方・下限・折り返しを出さない・重なる代替のまとめ方） → `stretchAlternatives.test.ts`、
 *   形の継ぎ方 → `routeSplice.test.ts`。ここでは分かれ道が1つずつの網で、出る・乗り換えた経路から次が出ることを見る
 * - 編集面の表示（差・戻す操作・失敗の出し方） → `RouteSplicePanel/RouteSplicePanel.test.tsx`
 * - 地図に帯が出る・消えることとタップ → `app/page.splice.test.tsx`（帯の色・線の形は`features/map/scene/groups/routes.ts`の宣言）
 * - 作った経路を結果へ足す・既存の候補を選ぶ → `useRouteResults.test.ts`・`app/page.splice.test.tsx`
 *
 * 差し替えたもの: 評価（生成のジョブ）と軸カタログの応答（網の層。`testing/spliceSession.ts`）。
 *
 * 通さない分岐（どれも入口から作れない）:
 * - 生成の入力が無いときの`start`: 始められるのは表示中の候補を作った生成があるときだけで、入口（`canStart`）が出ない
 * - 帯の相手が一覧に無い: 相手は同じ一覧から引く
 * - 1グループの選択肢の上限: 候補数の上限（`route-generate-config.json: max_routes`）より多くは並ばない
 * - 評価の入口の前提（編集・乗り換え・形が無い）と、編集が無いときの乗り換え: 呼ぶ側が先に同じ前提で止め（乗り換えていない間は
 *   編集面が差分と作成を押せなくする）、編集していない間は乗り換え先が出ない
 */
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { GenerationInput } from "@/features/route/generationRequest";
import { serveAxisCatalog } from "@/testing/backendServer";
import { catalogEntry, catalogResponse } from "@/testing/catalogAxes";
import { makeRouteCandidate } from "@/testing/routeFixtures";
import {
  BASE,
  BASIS,
  ELSEWHERE,
  PROPS,
  SPLICE_CATALOG,
  VIA_Q,
  VIA_Q_R,
  evaluated,
  line,
  press,
  renderSplice,
  serveSpliceEvaluations,
  startEditing,
  startWithCatalog,
  tapStretch,
  type SpliceProps,
} from "@/testing/spliceSession";
import type { RouteCandidate } from "@/types/route";

const CATALOG_WITHOUT_MIN_STRETCH = catalogResponse([catalogEntry({ axis_id: "axis_a", default_weight: 1 })]);

let evaluations: ReturnType<typeof serveSpliceEvaluations>;

beforeEach(() => {
  evaluations = serveSpliceEvaluations();
  serveAxisCatalog(SPLICE_CATALOG);
});

describe("入口", () => {
  it("候補が2本以上あり、候補を選んでいて、区間を割る下限を引けるときだけ始められる", async () => {
    const rendered = renderSplice();
    await waitFor(() => expect(rendered.result.current.canStart).toBe(true));

    const blocked: Partial<SpliceProps>[] = [{ routes: [BASE] }, { hasSelectedRoute: false }];
    for (const props of blocked) {
      rendered.rerender({ ...PROPS, ...props });
      expect(rendered.result.current.canStart).toBe(false);
    }
  });

  it("周回の候補からも始められ、組み合わせた経路を目的地を付けずに評価へ送る（終点は出発地）", async () => {
    const loop = (candidate: RouteCandidate): RouteCandidate => ({ ...candidate, kind: "loop" });
    const loopBasis: GenerationInput = { ...BASIS, distanceKm: 30, destination: null };
    const rendered = renderSplice({ routes: [loop(BASE), loop(VIA_Q)], generatedInput: loopBasis });
    await waitFor(() => expect(rendered.result.current.canStart).toBe(true));
    await startEditing(rendered);
    tapStretch(rendered);
    evaluations.respond([evaluated(ELSEWHERE)]);

    await press(rendered.result.current.panel?.onPreview);

    expect(evaluations.submitted).toHaveLength(1);
    expect(evaluations.submitted[0].body).toMatchObject({ spliced_edge_ids: VIA_Q.edge_ids });
    expect(evaluations.submitted[0].body).not.toHaveProperty("destination");
  });

  it("区間を割る下限を引けない間は始められず、始めても乗り換え先を作らない（較正と別の切り方で出さない）", async () => {
    serveAxisCatalog(CATALOG_WITHOUT_MIN_STRETCH);
    const rendered = renderSplice();

    await startWithCatalog(rendered);

    expect(rendered.result.current.canStart).toBe(false);
    expect(rendered.result.current.editingRoute).toEqual(BASE);
    expect(rendered.result.current.map.spliceStretches).toEqual([]);
    expect(rendered.result.current.panel?.hasAlternatives).toBe(false);
  });
});

describe("編集", () => {
  it("始めると元の候補を編集面と地図へ渡し、他の候補が別の道を通る区間を乗り換え先として出す", async () => {
    const rendered = renderSplice();

    await startEditing(rendered);

    const { result } = rendered;
    expect(result.current.editingRoute).toEqual(BASE);
    expect(result.current.panel).toMatchObject({
      displayed: BASE,
      appliedCount: 0,
      hasAlternatives: true,
      preview: null,
    });
    expect(result.current.map.splicedRoute).toEqual(line("n0", "n1", "n2", "n3"));
    expect(result.current.map.spliceStretches.map((stretch) => stretch.coordinates)).toEqual([line("n1", "nq", "n2")]);
  });

  it("乗り換え先を選ぶとその道へ乗り換え、乗り換えた経路から次の乗り換え先を出す。1つ戻す・全部戻すで戻る", async () => {
    const rendered = renderSplice({ routes: [BASE, VIA_Q, VIA_Q_R] });
    await startEditing(rendered);
    const viaQ = rendered.result.current.map.spliceStretches.findIndex(
      (stretch) => JSON.stringify(stretch.coordinates) === JSON.stringify(line("n1", "nq", "n2")),
    );

    tapStretch(rendered, viaQ);
    expect(rendered.result.current.panel?.appliedCount).toBe(1);
    expect(rendered.result.current.map.splicedRoute).toEqual(line("n0", "n1", "nq", "n2", "n3"));
    expect(rendered.result.current.map.spliceStretches.map((stretch) => stretch.coordinates)).toEqual([
      line("nq", "nr", "n2"),
    ]);

    tapStretch(rendered);
    expect(rendered.result.current.panel?.appliedCount).toBe(2);
    expect(rendered.result.current.map.splicedRoute).toEqual(line("n0", "n1", "nq", "nr", "n2", "n3"));

    act(() => rendered.result.current.panel?.onUndo());
    expect(rendered.result.current.panel?.appliedCount).toBe(1);
    expect(rendered.result.current.map.splicedRoute).toEqual(line("n0", "n1", "nq", "n2", "n3"));

    act(() => rendered.result.current.panel?.onReset());
    expect(rendered.result.current.panel?.appliedCount).toBe(0);
    expect(rendered.result.current.map.splicedRoute).toEqual(line("n0", "n1", "n2", "n3"));
  });

  it("地図から知らない乗り換え先が届いても何も変えない", async () => {
    const rendered = renderSplice();
    await startEditing(rendered);

    act(() => rendered.result.current.map.onSpliceStretchSelect(9999));

    expect(rendered.result.current.panel?.appliedCount).toBe(0);
  });

  it("線の形を持たない候補（Edge idだけ）では、地図に描けない乗り換え先を出さない", async () => {
    const edgesOnly = (route: RouteCandidate) =>
      makeRouteCandidate({
        id: route.id,
        kind: route.kind,
        edge_ids: route.edge_ids,
        node_ids: route.node_ids,
      });
    const rendered = renderSplice({ routes: [edgesOnly(BASE), edgesOnly(VIA_Q)] });

    await startWithCatalog(rendered);

    expect(rendered.result.current.canStart).toBe(true);
    expect(rendered.result.current.map.spliceStretches).toEqual([]);
  });

  it("やめると編集面も地図の乗り換え先も消え、次に始めた編集は空から始まる", async () => {
    const rendered = renderSplice();
    await startEditing(rendered);
    tapStretch(rendered);

    act(() => rendered.result.current.panel?.onCancel());
    expect(rendered.result.current.editingRoute).toBeNull();
    expect(rendered.result.current.panel).toBeNull();
    expect(rendered.result.current.map.spliceStretches).toEqual([]);
    expect(rendered.result.current.map.splicedRoute).toBeNull();

    act(() => rendered.result.current.start("base"));
    expect(rendered.result.current.panel?.appliedCount).toBe(0);
  });

  it("作り直すと（表示中の候補を作った生成が替わると）、候補のidが同じでも編集は終わる", async () => {
    const rendered = renderSplice();
    await startEditing(rendered);

    rendered.rerender({ ...PROPS, generatedInput: { ...BASIS } });

    expect(rendered.result.current.editingRoute).toBeNull();
  });

  it("編集の元の候補が一覧から消えたら、編集は効かない", async () => {
    const rendered = renderSplice();
    await startEditing(rendered);

    rendered.rerender({ ...PROPS, routes: [VIA_Q] });

    expect(rendered.result.current.editingRoute).toBeNull();
  });
});
