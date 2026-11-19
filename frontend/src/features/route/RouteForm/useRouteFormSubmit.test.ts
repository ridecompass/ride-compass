/**
 * 生成の前の検証（`RouteForm/useRouteFormSubmit.ts`）——周回で距離の目標を決めず経由地も無ければ、作るものが無いのでどちらかを促す。周回を外して
 * 目的地が無ければ、目的地か周回を促す。通れば前の文言を消す。
 *
 * ここで見ないもの:
 * - 出発地が仮の地点のままのとき（窓を出さず出発地の行へ導く） → `app/page.mobile.test.tsx`
 * - 文言を出す場所（「ルート結果」欄・モバイルの「ルート設定」シート） → `RouteOutcome/RouteOutcome.test.tsx`・`app/page.mobile.test.tsx`
 * - 検証を通った値で何を送るか（距離・経由地・目的地・候補数） → `useRouteGeneration.test.ts`
 * - 候補数の選び手が並べる数 → `GenerateRouteActions/GenerateRouteActions.test.tsx`
 * - 距離・候補数の値域 → 検証しない（入力はルーラー・件数の選び手で、保存値は読むときに範囲の外を捨てる。
 *   `useGenerationConditions.test.ts`）
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useRouteFormSubmit } from "./useRouteFormSubmit";

const NOTHING_TO_MAKE = "定規の「距離を決める」をオンにするか、経由地を置いてください。";
const NO_DESTINATION = "目的地を置いてください[出発地へ戻るなら「周回」を押してください]。";

interface Options {
  loop: boolean;
  distanceTargeted: boolean;
  waypointCount: number;
  destinationSet: boolean;
}

const LOOP: Options = {
  loop: true,
  distanceTargeted: true,
  waypointCount: 0,
  destinationSet: false,
};
const LOOP_NO_DISTANCE: Options = { ...LOOP, distanceTargeted: false };
const TO_DESTINATION: Options = { ...LOOP, loop: false, destinationSet: true };

function renderSubmit(options: Options) {
  return renderHook((props: Options) => useRouteFormSubmit(props), { initialProps: options });
}

function check(result: { current: ReturnType<typeof useRouteFormSubmit> }) {
  let passed: boolean | undefined;
  act(() => {
    passed = result.current.check();
  });
  return passed;
}

describe("useRouteFormSubmit", () => {
  it.each([
    { label: "周回で距離の目標だけ", options: LOOP },
    { label: "目的地へ向かい距離の目標なし", options: { ...TO_DESTINATION, distanceTargeted: false } },
  ])("「$label」なら生成する", ({ options }) => {
    const { result } = renderSubmit(options);

    expect(check(result)).toBe(true);
  });

  it("周回で距離の目標を決めず経由地も無ければ生成せず、どちらかを促す。文言は押し直すまで残り、経由地を置いて押し直すと消えて生成する", () => {
    const { result, rerender } = renderSubmit(LOOP_NO_DISTANCE);
    expect(check(result)).toBe(false);
    expect(result.current.error).toBe(NOTHING_TO_MAKE);

    rerender({ ...LOOP_NO_DISTANCE, waypointCount: 1 });
    expect(result.current.error).toBe(NOTHING_TO_MAKE);

    expect(check(result)).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("周回を外して目的地を置いていなければ、距離の目標と経由地があっても生成せず、目的地か周回を促す", () => {
    const { result } = renderSubmit({ ...TO_DESTINATION, destinationSet: false, waypointCount: 2 });

    expect(check(result)).toBe(false);
    expect(result.current.error).toBe(NO_DESTINATION);
  });
});
