// @vitest-environment node
import { describe, expect, it } from "vitest";

import { popupPlacementAround, type ScreenBox } from "./popupPlacement";

const VISIBLE: ScreenBox = { left: 0, top: 0, right: 400, bottom: 600 };
const POPUP = { width: 200, height: 150 };
const GAP = 10;

describe("popupPlacementAround", () => {
  it("区間にかぶらない側を、上・下・右・左の順に、見えている所に収まる最初の側から選ぶ", () => {
    const at = (around: ScreenBox) => popupPlacementAround(around, POPUP, VISIBLE, GAP);
    // 上に 150+10 の空きがある（上辺 160 ちょうど）。
    expect(at({ left: 150, top: 160, right: 250, bottom: 200 })).toEqual({ anchor: "bottom", x: 200, y: 160 });
    // 上は1px足りず、下に収まる。
    expect(at({ left: 150, top: 159, right: 250, bottom: 200 })).toEqual({ anchor: "top", x: 200, y: 200 });
    // 上下とも足りず、右に 200+10 の空きがある。
    expect(at({ left: 10, top: 100, right: 190, bottom: 500 })).toEqual({ anchor: "left", x: 190, y: 300 });
    // 上下右が足りず、左に収まる。
    expect(at({ left: 210, top: 100, right: 390, bottom: 500 })).toEqual({ anchor: "right", x: 210, y: 300 });
    // 今の向きの側が収まるなら、先の順の側が収まっても入れ替えない。
    expect(popupPlacementAround({ left: 150, top: 160, right: 250, bottom: 200 }, POPUP, VISIBLE, GAP, "top")).toEqual({
      anchor: "top",
      x: 200,
      y: 200,
    });
    // 見えている所が無い地図では、小さな小窓でも選ばない。
    const empty = { left: 0, top: 0, right: 0, bottom: 0 };
    expect(popupPlacementAround(empty, { width: 0, height: 0 }, { ...empty, top: -100 }, 0)).toBeNull();
  });

  it("側に沿う向きにはみ出すなら、見えている所の中へずらしてその側に置く", () => {
    // 区間の真ん中が左端に寄り、上に置くと小窓の左半分がはみ出すので、右へずらして上に置く。
    expect(popupPlacementAround({ left: 0, top: 300, right: 60, bottom: 320 }, POPUP, VISIBLE, GAP)).toEqual({
      anchor: "bottom",
      x: 100,
      y: 300,
    });
    // 上下とも足りず右に置くとき、区間の真ん中が下端に寄っていれば、上へずらす。
    expect(popupPlacementAround({ left: 10, top: 100, right: 190, bottom: 1000 }, POPUP, VISIBLE, GAP)).toEqual({
      anchor: "left",
      x: 190,
      y: 525,
    });
  });

  it("どの側にも収まらなければ、空きの一番大きい側に、見えている所の内側へ押し込めて置く", () => {
    const at = (around: ScreenBox) => popupPlacementAround(around, POPUP, VISIBLE, GAP);
    // 見えている所いっぱいの道。上の空き（100）が一番大きいので上に置き、上の端を見えている所の上端に揃える（道に一部かぶる）。
    expect(at({ left: 0, top: 100, right: 400, bottom: 520 })).toEqual({ anchor: "bottom", x: 200, y: 160 });
    // 区間が見えている所の上の外にあり、下に置くと小窓の上の端が見えている所の外に出る。下の空きが一番大きいので、見えている所の
    // 上端から下に置く。
    expect(at({ left: 150, top: -300, right: 250, bottom: -50 })).toEqual({ anchor: "top", x: 200, y: -10 });
  });
});
