/**
 * 区間の乗り換えの編集（`useSpliceSession.ts`）の「差分を見る」——組み合わせた経路を、表示中の候補を作った生成の入力で
 * backendに評価させ、結果を編集面へ渡す（同じ組み合わせは投げ直さない。評価が既にある候補と同じ道ならその候補も渡す）。
 * 評価を待つ間に作り直して始め直すと、届いた評価は何も書かない。
 *
 * ここで見ないもの:
 * - 始め方・乗り換え・戻す・やめる → `useSpliceSession.test.ts`
 * - 評価した経路で作る → `useSpliceSession.apply.test.ts`
 * - 編集面の表示（差・失敗の出し方） → `RouteSplicePanel/RouteSplicePanel.test.tsx`
 *
 * 差し替えたもの: 評価（生成のジョブ）と軸カタログの応答（網の層。`testing/spliceSession.ts`）。評価はジョブを作り
 * backendの回数制限に数えられるので、出した要求の数と中身を確かめる。
 */
import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { serveAxisCatalog } from "@/testing/backendServer";
import {
  BASE,
  BASIS,
  ELSEWHERE,
  PROPS,
  SPLICE_CATALOG,
  VIA_Q,
  VIA_Q_R,
  evaluated,
  press,
  renderSplice,
  serveSpliceEvaluations,
  startEditing,
  tapStretch,
} from "@/testing/spliceSession";

let evaluations: ReturnType<typeof serveSpliceEvaluations>;

beforeEach(() => {
  evaluations = serveSpliceEvaluations();
  serveAxisCatalog(SPLICE_CATALOG);
});

describe("差分を見る", () => {
  it("表示中の候補を作った入力へ、乗り換えた経路のEdge列を載せて評価し、結果を編集面へ渡す。同じ組み合わせは投げ直さない", async () => {
    const rendered = renderSplice();
    await startEditing(rendered);
    tapStretch(rendered);
    const result = evaluated(VIA_Q.edge_ids);
    evaluations.respond([result]);

    await press(rendered.result.current.panel?.onPreview);

    expect(evaluations.submitted).toHaveLength(1);
    expect(evaluations.submitted[0].body).toMatchObject({
      latitude: BASIS.origin.latitude,
      longitude: BASIS.origin.longitude,
      max_routes: BASIS.maxRoutes,
      assumed_speed_kmh: BASIS.assumedSpeedKmh,
      route_preference: BASIS.routePreference,
      destination: { ...BASIS.destination },
      spliced_edge_ids: VIA_Q.edge_ids,
    });
    expect(rendered.result.current.panel?.preview).toEqual(result);

    // 戻して選び直しても、覚えた評価を出して投げ直さない。
    act(() => rendered.result.current.panel?.onUndo());
    expect(rendered.result.current.panel?.preview).toBeNull();
    tapStretch(rendered);
    expect(rendered.result.current.panel?.preview).toEqual(result);
    await press(rendered.result.current.panel?.onPreview);
    expect(evaluations.submitted).toHaveLength(1);
  });

  it.each([
    ["既にある候補と同じ道なら、その候補", VIA_Q.edge_ids, "via-q"],
    ["どの候補とも違う道なら、無いこと", ELSEWHERE, null],
  ])("評価した組み合わせが%sを編集面へ渡す", async (_, edgeIds, sameRouteId) => {
    const rendered = renderSplice();
    await startEditing(rendered);
    tapStretch(rendered);
    evaluations.respond([evaluated(edgeIds)]);

    await press(rendered.result.current.panel?.onPreview);

    expect(rendered.result.current.panel?.sameRouteId).toBe(sameRouteId);
  });

  it("評価を待っている間は待っていると返し、選び直しても続ける。待っている間に押しても投げ直さない", async () => {
    const rendered = renderSplice({ routes: [BASE, VIA_Q, VIA_Q_R] });
    await startEditing(rendered);
    tapStretch(rendered);
    const pending = evaluations.deferred();
    let first: unknown;
    act(() => {
      first = rendered.result.current.panel?.onPreview();
    });
    expect(rendered.result.current.panel?.previewing).toBe(true);

    await press(rendered.result.current.panel?.onPreview);
    tapStretch(rendered);
    expect(rendered.result.current.panel?.previewing).toBe(true);
    expect(evaluations.submitted).toHaveLength(1);

    await act(async () => {
      await pending.resolve([evaluated(VIA_Q.edge_ids)]);
      await first;
    });
    expect(rendered.result.current.panel?.previewing).toBe(false);
  });

  it.each([
    {
      label: "評価が理由を付けて空で返る",
      outcome: () => evaluations.respond([], "組み合わせた経路がつながっていないため評価できませんでした。"),
      message: "組み合わせた経路がつながっていないため評価できませんでした。",
    },
    {
      label: "評価が理由を付けずに空で返る",
      outcome: () => evaluations.respond([]),
      message: "組み合わせたルートを評価できませんでした",
    },
    { label: "評価に失敗する", outcome: () => evaluations.fail(), message: "リクエストに失敗しました" },
  ])("「$label」と、理由を編集面に出す。次に乗り換え先を選ぶ・戻すと消す", async ({ outcome, message }) => {
    const rendered = renderSplice({ routes: [BASE, VIA_Q, VIA_Q_R] });
    await startEditing(rendered);
    tapStretch(rendered);

    for (const clear of [() => tapStretch(rendered), () => act(() => rendered.result.current.panel?.onUndo())]) {
      outcome();
      await press(rendered.result.current.panel?.onPreview);
      expect(rendered.result.current.panel?.error).toBe(message);
      expect(rendered.result.current.panel?.preview).toBeNull();

      clear();
      expect(rendered.result.current.panel?.error).toBeNull();
    }

    outcome();
    await press(rendered.result.current.panel?.onPreview);
    act(() => rendered.result.current.panel?.onReset());
    expect(rendered.result.current.panel?.error).toBeNull();
  });

  it("評価を待っている間に作り直して編集を始め直したら、あとから届いた評価を新しい編集へ書かない", async () => {
    const rendered = renderSplice();
    await startEditing(rendered);
    tapStretch(rendered);
    const pending = evaluations.deferred();
    let first: unknown;
    act(() => {
      first = rendered.result.current.panel?.onPreview();
    });

    rendered.rerender({ ...PROPS, generatedInput: { ...BASIS } });
    await startEditing(rendered);
    tapStretch(rendered);
    await act(async () => {
      await pending.resolve([evaluated(VIA_Q.edge_ids)]);
      await first;
    });

    expect(rendered.result.current.panel?.preview).toBeNull();
    expect(rendered.result.current.panel?.previewing).toBe(false);
  });
});
