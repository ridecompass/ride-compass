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
    // どこにも収まらない（見えている所いっぱいの区間）。
    expect(at({ left: 0, top: 0, right: 400, bottom: 600 })).toBeNull();
    // 見えている所が無い地図では、小さな小窓でも選ばない。
    const empty = { left: 0, top: 0, right: 0, bottom: 0 };
    expect(popupPlacementAround(empty, { width: 0, height: 0 }, { ...empty, top: -100 }, 0)).toBeNull();
  });

  it("上下に置くとき、小窓が見えている所から横へはみ出すなら、その側を選ばない", () => {
    // 区間の真ん中が左端に寄り、上に置くと小窓の左半分がはみ出す。右に置ける。
    expect(popupPlacementAround({ left: 0, top: 300, right: 60, bottom: 320 }, POPUP, VISIBLE, GAP)).toEqual({
      anchor: "left",
      x: 60,
      y: 310,
    });
  });
});
