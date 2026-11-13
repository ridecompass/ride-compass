// @vitest-environment node
import { describe, expect, it } from "vitest";

import { popupInsideVisible, type ScreenBox } from "./popupPlacement";

const VISIBLE: ScreenBox = { left: 0, top: 50, right: 400, bottom: 600 };

/** 左上と大きさから、小窓の矩形を作る。 */
const popupAt = (left: number, top: number, width = 200, height = 150): ScreenBox => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe("popupInsideVisible", () => {
  it("見えている所に収まっている小窓は動かさない", () => {
    expect(popupInsideVisible(popupAt(100, 200), VISIBLE)).toEqual({ left: 100, top: 200 });
  });

  it("はみ出した小窓は、はみ出した辺を見えている所の辺に合わせる", () => {
    expect(popupInsideVisible(popupAt(-30, 20), VISIBLE)).toEqual({ left: 0, top: 50 });
    expect(popupInsideVisible(popupAt(350, 500), VISIBLE)).toEqual({ left: 200, top: 450 });
  });

  it("見えている所より大きい小窓は、左と上を揃える", () => {
    expect(popupInsideVisible(popupAt(-30, 300, 500, 700), VISIBLE)).toEqual({ left: 0, top: 50 });
  });

  it("残す分を渡すと、左・右・下へはその分が見えている所に残るまで出られ、上の辺は見えている所に残す", () => {
    expect(popupInsideVisible(popupAt(-100, 200), VISIBLE, 96)).toEqual({ left: -100, top: 200 });
    expect(popupInsideVisible(popupAt(-150, 200, 500), VISIBLE, 96)).toEqual({ left: -150, top: 200 });
    expect(popupInsideVisible(popupAt(-450, 560, 500), VISIBLE, 96)).toEqual({ left: -404, top: 504 });
    expect(popupInsideVisible(popupAt(380, 20), VISIBLE, 96)).toEqual({ left: 304, top: 50 });
  });

  it("見えている所が無い（描く前・隠れている地図）なら選ばない", () => {
    expect(popupInsideVisible(popupAt(100, 200), { left: 0, top: 50, right: 0, bottom: 600 })).toBeNull();
  });
});
