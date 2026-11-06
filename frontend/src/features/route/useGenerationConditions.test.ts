/**
 * 生成の条件（`useGenerationConditions.ts`）——周回か・全長の目標を決めるか・距離・候補数・つまみと倍率・道ごとの避け方を返す。
 * 保存する値（地点以外）は開き直しても残り、読むときに今の画面が受け付ける範囲・
 * 今の項目へ揃える。倍率は、費用の軸の一覧が届いた後に、今の軸のものだけを送る。
 *
 * ここで見ないもの:
 * - 地点（出発地以外）の置き方・動かし方・消し方と、検索・名前のある点で置いた地点の候補と、周回の間に覚えておく目的地 →
 *   `useGenerationConditions.points.test.ts`
 * - つまみと倍率の保存値の読み方（範囲の外・前の形） → `savedConditions.test.ts`。ここでは寄せていることを1件見る
 * - 一覧が届かない間に倍率を送らないこと → `useRouteGeneration.result.test.ts`
 * - 保存の読み書きそのもの（読めない・書けない端末で既定値になる） → `hooks/useStoredState.test.ts`
 * - 地図で置いた出発地を位置の持ち主が受け取ったあと → `hooks/useLocation.test.ts`
 * - 地図のタップが選んだ地点を置く場面（「ルート設定」の「条件」タブが効いている間だけ） → `app/page.map.test.tsx`
 * - 条件を生成へ送る形 → `useRouteGeneration.test.ts`
 *
 * 差し替えたもの: 費用の軸の一覧の応答（網の層）。保存はテスト環境の`localStorage`を
 * 本物のまま使い、開き直しは同じ保存の上でフックを描き直して作る。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { heldReplies, onBackend, serveCostAxisCatalog } from "@/testing/backendServer";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

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

  it.each([
    {
      label: "上限ちょうど",
      saved: String(routeGenerateConfig.max_distance_km),
      read: String(routeGenerateConfig.max_distance_km),
    },
    { label: "1km刻みだった頃の値は近い方の刻みへ（下へ）", saved: "37", read: "35" },
    { label: "1km刻みだった頃の値は近い方の刻みへ（上へ）", saved: "38", read: "40" },
    { label: "最初の刻みより短い", saved: "1", read: "5" },
    { label: "0km", saved: "0", read: "30" },
    { label: "上限より長い", saved: String(routeGenerateConfig.max_distance_km + 1), read: "30" },
    { label: "数でない", saved: "abc", read: "30" },
  ])("距離の保存値は、範囲の中なら5km刻みへ寄せて受け入れ、外なら既定の30kmにする（$label）", ({ saved, read }) => {
    window.localStorage.setItem("ridecompass:distance-km", saved);

    expect(renderConditions().result.current.distanceInput).toBe(read);
  });

  it.each([
    { label: "1件ちょうど", saved: "1", accepted: true },
    { label: "上限ちょうど", saved: String(routeGenerateConfig.max_routes), accepted: true },
    { label: "0件", saved: "0", accepted: false },
    { label: "上限より多い", saved: String(routeGenerateConfig.max_routes + 1), accepted: false },
    { label: "整数でない", saved: "2.5", accepted: false },
  ])("候補数の保存値は範囲の中の整数だけを受け入れる（$label）", ({ saved, accepted }) => {
    window.localStorage.setItem("ridecompass:max-routes", saved);

    expect(renderConditions().result.current.maxRoutesInput).toBe(
      accepted ? saved : String(routeGenerateConfig.default_max_routes),
    );
  });
});

describe("つまみと倍率", () => {
  it("既定は標準で、変えたつまみと倍率は開き直しても残り、送るのは今の費用の軸の、標準でない倍率だけ", async () => {
    serveCostAxisCatalog();
    const first = renderConditions();
    expect(first.result.current.costPreference).toEqual(STANDARD_COST_PREFERENCE);
    act(() =>
      first.result.current.setCostPreference({
        ...STANDARD_COST_PREFERENCE,
        strength: 1.5,
        multipliers: { ascent: 2, vibration: 1, gone: 3 },
      }),
    );

    const { result } = reopen(first);

    await waitFor(() =>
      expect(result.current.costPreferenceToSend).toEqual({
        ...STANDARD_COST_PREFERENCE,
        strength: 1.5,
        multipliers: { ascent: 2 },
      }),
    );
  });

  it("前の形（割合の重み）の保存値は読まず、標準に戻す", () => {
    window.localStorage.setItem("ridecompass:cost-preference", JSON.stringify({ axis_a: 0.7 }));

    expect(renderConditions().result.current.costPreference).toEqual(STANDARD_COST_PREFERENCE);
  });
});

describe("道ごとの避け方", () => {
  it("変えた避け方は開き直しても残る", () => {
    const first = renderConditions();

    act(() => first.result.current.setRoadAvoidance({ gravel: "exclude" }));

    expect(reopen(first).result.current.roadAvoidance).toEqual({ gravel: "exclude" });
  });

  // 行は画面の設定が届くまで分からないので、鍵では落とさない（今の行へ揃えるのはbackend）。
  it("保存値は段として読める鍵だけを残す", () => {
    window.localStorage.setItem(
      "ridecompass:road-avoidance",
      JSON.stringify({ gravel: "exclude", unpaved: "retired_level", "retired.row": "avoid" }),
    );
    expect(renderConditions().result.current.roadAvoidance).toEqual({ gravel: "exclude", "retired.row": "avoid" });
  });
});
