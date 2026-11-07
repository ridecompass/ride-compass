/**
 * 生成の条件（`useGenerationConditions.ts`）——周回か・全長の目標を決めるか・距離・候補数・つまみと倍率・道ごとの避け方を返す。
 * 保存する値（地点以外）は開き直しても残る。倍率は、費用の軸の一覧が届いた後に、今の軸のものだけを送る。
 *
 * ここで見ないもの:
 * - 地点（出発地以外）の置き方・動かし方・消し方と、検索・名前のある点で置いた地点の候補と、周回の間に覚えておく目的地 →
 *   `useGenerationConditions.points.test.ts`
 * - 一覧が届かない間に倍率を送らないこと → `useRouteGeneration.result.test.ts`
 * - 保存の読み書きそのもの → `hooks/useStoredState.test.tsx`
 * - 地図で置いた出発地を位置の持ち主が受け取ったあと → `hooks/useLocation.test.ts`
 * - 地図のタップが選んだ地点を置く場面（「ルート設定」の「条件」タブが効いている間だけ） → `app/page.map.test.tsx`
 * - 条件を生成へ送る形 → `useRouteGeneration.test.ts`
 *
 * 差し替えたもの: 費用の軸の一覧の応答（網の層）。保存はテスト環境の`localStorage`を
 * 本物のまま使い、開き直しは同じ保存の上でフックを描き直して作る。
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { heldReplies, onBackend } from "@/testing/backendServer";

import { useGenerationConditions } from "./useGenerationConditions";
import { STANDARD_COST_PREFERENCE } from "@/lib/costPreference";

function renderConditions() {
  const onOriginPlace = vi.fn();
  const rendered = renderHook(() => useGenerationConditions({ onOriginPlace }));
  return { ...rendered, onOriginPlace };
}

/** 同じ保存の上で開き直す。 */
function reopen(rendered: { unmount: () => void }) {
  rendered.unmount();
  return renderConditions();
}

beforeEach(() => {
  window.localStorage.clear();
  // 既定は届かないまま（倍率を見るテストだけが届ける）。
  onBackend("GET", "/api/cost-axes", heldReplies().reply);
});

describe("周回と全長の目標", () => {
  it.each([
    { label: "周回", read: "loop", set: "setLoop" },
    { label: "全長の目標", read: "distanceTargeted", set: "setDistanceTargeted" },
  ] as const)("$labelは既定で入っていて、外したことは開き直しても残る", ({ read, set }) => {
    const first = renderConditions();
    expect(first.result.current[read]).toBe(true);

    act(() => first.result.current[set](false));

    expect(reopen(first).result.current[read]).toBe(false);
  });
});

describe("距離と候補数", () => {
  it("入力した値は文字列のまま持ち、開き直しても残る", () => {
    const first = renderConditions();
    act(() => first.result.current.setDistanceInput("55"));
    act(() => first.result.current.setMaxRoutesInput("3"));

    const { result } = reopen(first);

    expect(result.current.distanceInput).toBe("55");
    expect(result.current.maxRoutesInput).toBe("3");
  });
});

describe("つまみと倍率", () => {
  it("既定は標準で、変えたつまみと倍率は開き直しても残る", () => {
    const first = renderConditions();
    act(() =>
      first.result.current.setCostPreference({
        ...STANDARD_COST_PREFERENCE,
        strength: 1.5,
        multipliers: { ascent: 2, vibration: 1, gone: 2 },
      }),
    );

    expect(reopen(first).result.current.costPreference).toEqual({
      ...STANDARD_COST_PREFERENCE,
      strength: 1.5,
      multipliers: { ascent: 2, vibration: 1, gone: 2 },
    });
  });
});

describe("道ごとの避け方", () => {
  it("変えた避け方は開き直しても残る", () => {
    const first = renderConditions();

    act(() => first.result.current.setRoadAvoidance({ gravel: "exclude" }));

    expect(reopen(first).result.current.roadAvoidance).toEqual({ gravel: "exclude" });
  });
});
