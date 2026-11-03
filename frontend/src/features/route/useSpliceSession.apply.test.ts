/**
 * 区間の乗り換えの編集（`useSpliceSession.ts`）の「作成」——評価の間は作成中で、評価した経路を元の候補と一緒に渡して
 * 編集を終える（評価が既にある候補と同じ道なら、作らずにその候補を渡す）。差分を見た組み合わせは投げ直さず、連打しても
 * 投げるのは1回。評価を待つ間に作り直して始め直すと、届いた評価で作らない。
 *
 * ここで見ないもの:
 * - 始め方・乗り換え・戻す・やめる → `useSpliceSession.test.ts`
 * - 評価の中身（送る入力・同じ組み合わせを覚える） → `useSpliceSession.preview.test.ts`
 * - 作った経路を結果へ足す・既存の候補を選ぶ → `useRouteResults.test.ts`・`app/page.splice.test.tsx`
 *
 * 差し替えたもの: 評価（生成のジョブ）と軸カタログの応答（網の層。`testing/spliceSession.ts`）。評価はジョブを作り
 * backendの回数制限に数えられるので、出した要求の数を確かめる。
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

describe("作成", () => {
  it("評価の間は作成中で、評価した経路を元の候補と一緒に渡して編集を終える", async () => {
    const rendered = renderSplice();
    await startEditing(rendered);
    tapStretch(rendered);
    const created = evaluated(ELSEWHERE);
    const pending = evaluations.deferred();
    let applying: unknown;
    act(() => {
      applying = rendered.result.current.panel?.onApply();
    });
    expect(rendered.onApplied).not.toHaveBeenCalled();
    expect(rendered.result.current.panel?.applying).toBe(true);

    await act(async () => {
      await pending.resolve([created]);
      await applying;
    });

    expect(rendered.onApplied).toHaveBeenCalledWith({ created, originId: "base" });
    expect(rendered.result.current.editingRoute).toBeNull();
  });

  it("作成中に地図の乗り換え先を押しても乗り換えない（押した時点の組み合わせで作って編集を閉じるので、押した乗り換えが黙って消える）", async () => {
    const rendered = renderSplice({ routes: [BASE, VIA_Q, VIA_Q_R] });
    await startEditing(rendered);
    tapStretch(rendered);
    const pending = evaluations.deferred();
    let applying: unknown;
    act(() => {
      applying = rendered.result.current.panel?.onApply();
    });

    tapStretch(rendered);
    expect(rendered.result.current.panel?.appliedCount).toBe(1);

    await act(async () => {
      await pending.resolve([evaluated(ELSEWHERE)]);
      await applying;
    });
  });

  it("差分を見た組み合わせは、作るときに投げ直さず、見た評価で作る", async () => {
    const rendered = renderSplice();
    await startEditing(rendered);
    tapStretch(rendered);
    const created = evaluated(ELSEWHERE);
    evaluations.respond([created]);

    await press(rendered.result.current.panel?.onPreview);
    await press(rendered.result.current.panel?.onApply);

    expect(evaluations.submitted).toHaveLength(1);
    expect(rendered.onApplied).toHaveBeenCalledWith({ created, originId: "base" });
  });

  it("作った経路が既にある候補と同じ道なら、作らずにその候補を渡す", async () => {
    const rendered = renderSplice();
    await startEditing(rendered);
    tapStretch(rendered);
    evaluations.respond([evaluated(VIA_Q.edge_ids)]);

    await press(rendered.result.current.panel?.onApply);

    expect(rendered.onApplied).toHaveBeenCalledWith({ existingRouteId: "via-q" });
  });

  it("連打しても投げるのは1回で、渡すのも1回", async () => {
    const rendered = renderSplice();
    await startEditing(rendered);
    tapStretch(rendered);
    evaluations.respond([evaluated(ELSEWHERE)]);

    await act(async () => {
      const apply = rendered.result.current.panel?.onApply;
      await Promise.all([apply?.(), apply?.()]);
    });

    expect(evaluations.submitted).toHaveLength(1);
    expect(rendered.onApplied).toHaveBeenCalledTimes(1);
  });

  it("評価を待っている間に作り直して編集を始め直したら、あとから届いた評価で作らず、始め直した編集を閉じない", async () => {
    const rendered = renderSplice();
    await startEditing(rendered);
    tapStretch(rendered);
    const pending = evaluations.deferred();
    let applying: unknown;
    act(() => {
      applying = rendered.result.current.panel?.onApply();
    });

    rendered.rerender({ ...PROPS, generatedInput: { ...BASIS } });
    await startEditing(rendered);
    await act(async () => {
      await pending.resolve([evaluated(ELSEWHERE)]);
      await applying;
    });

    expect(rendered.onApplied).not.toHaveBeenCalled();
    expect(rendered.result.current.editingRoute).toEqual(BASE);
    expect(rendered.result.current.panel?.applying).toBe(false);
  });

  it.each([
    {
      label: "評価が空で返る",
      outcome: () => evaluations.respond([]),
      message: "組み合わせたルートを評価できませんでした",
    },
    { label: "評価に失敗する", outcome: () => evaluations.fail(), message: "リクエストに失敗しました" },
  ])("「$label」と、編集を続けたまま理由を出し、もう一度作れる", async ({ outcome, message }) => {
    const rendered = renderSplice();
    await startEditing(rendered);
    tapStretch(rendered);
    outcome();

    await press(rendered.result.current.panel?.onApply);

    expect(rendered.onApplied).not.toHaveBeenCalled();
    expect(rendered.result.current.panel?.error).toBe(message);
    expect(rendered.result.current.panel?.applying).toBe(false);

    evaluations.respond([evaluated(ELSEWHERE)]);
    await press(rendered.result.current.panel?.onApply);
    expect(rendered.onApplied).toHaveBeenCalledTimes(1);
  });
});
