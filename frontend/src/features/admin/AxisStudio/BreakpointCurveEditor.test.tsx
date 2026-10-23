/**
 * `BreakpointCurveEditor.tsx`——動かせる端を矢印キーとドラッグで横に動かす口、横軸の範囲（渡した範囲に前後1割の余白）、
 * 背景へ重ねる分布（棒・分位線・範囲外の割合）。
 *
 * 動かした結果は `onChangeHandle` で親へ渡すだけで、折れ点そのものは親が持つ。
 *
 * ここで見ないもの:
 * - 分布の按分・範囲外の割合の計算 → `curveDistributionOverlay.test.ts`（期待値はそこの関数から引く）
 * - 刻みの選び方 → `breakpointTools.test.ts`（期待値は `niceStep` から引く）
 * - 段の境界を動かす操作と、どの点を動かせる端にするか → `AxisCalibration.test.tsx`
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BreakpointCurveEditor } from "./BreakpointCurveEditor";
import { niceStep } from "./breakpointTools";
import { OFF_RANGE_NOTICE_THRESHOLD } from "./curveDistributionOverlay";
import type { ValueDistribution } from "./scoreDistribution";

const POINTS: [number, number][] = [
  [0, 0],
  [10, 100],
];
const RANGE = { min: 0, max: 10 };

function distribution(overrides: Partial<ValueDistribution> = {}): ValueDistribution {
  return { sample_ways: 1, total_km: 1, quantiles: {}, bins: [], ...overrides };
}

function renderEditor(props: Partial<Parameters<typeof BreakpointCurveEditor>[0]> = {}) {
  const onChangeHandle = vi.fn();
  const view = render(
    <BreakpointCurveEditor
      breakpoints={POINTS}
      handles={[{ index: 1, label: "100点の端" }]}
      onChangeHandle={onChangeHandle}
      xRange={RANGE}
      distribution={null}
      referenceLine={null}
      boundaries={[]}
      onChangeBoundary={vi.fn()}
      {...props}
    />,
  );
  return { onChangeHandle, svg: screen.getByRole("img"), ...view };
}

function tickLabels(svg: HTMLElement): string[] {
  return Array.from(svg.querySelectorAll("g > text")).map((text) => text.textContent ?? "");
}

describe("BreakpointCurveEditor", () => {
  it("渡した端だけを、名前と入力値を名乗る動かせる点にする", () => {
    renderEditor();
    const handles = screen.getAllByRole("slider");
    expect(handles).toHaveLength(1);
    expect(handles[0]).toHaveAccessibleName("100点の端");
    expect(handles[0]).toHaveAttribute("aria-valuenow", "10");
  });

  it("左右キーは横軸の刻みで動かし、Shiftを押すと10倍にする。上下キーでは動かさない", () => {
    const { onChangeHandle } = renderEditor();
    const step = niceStep((RANGE.max - RANGE.min) * 1.2);
    const handle = screen.getByRole("slider");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    fireEvent.keyDown(handle, { key: "Enter" });

    expect(onChangeHandle.mock.calls).toEqual([
      [1, 10 + step],
      [1, 10 - step * 10],
    ]);
  });

  it("ボタンを押したままドラッグすると、指の横の位置を横軸の刻みへ丸めて渡し、動かしている間は値を出す。押していない移動では動かさない", () => {
    const { onChangeHandle, svg } = renderEditor();
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 720, height: 320 }) as DOMRect;
    const handle = screen.getByRole("slider");
    handle.setPointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { pointerId: 1 });
    expect(svg).toHaveTextContent("10 → 100");

    // 横軸は-1〜11（範囲の前後1割）で、描画域は左右の余白36を除く幅648。6の位置より少し右は、刻みへ丸めて6になる。
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 36 + (7 / 12) * 648 + 2, clientY: 10 });
    expect(onChangeHandle.mock.calls).toEqual([[1, 6]]);

    fireEvent.pointerUp(handle);
    expect(svg).not.toHaveTextContent("10 → 100");

    fireEvent.pointerMove(handle, { buttons: 0, clientX: 100, clientY: 50 });
    expect(onChangeHandle).toHaveBeenCalledTimes(1);
  });

  it("ドラッグがブラウザに取り消されたら（スクロールへの切り替え等）、動かしている間の値を消す", () => {
    const { svg } = renderEditor();
    const handle = screen.getByRole("slider");
    handle.setPointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { pointerId: 1 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(svg).not.toHaveTextContent("10 → 100");
  });

  it("横軸を、折れ点ではなく渡した範囲（前後1割の余白つき）で決める", () => {
    const labels = tickLabels(renderEditor({ xRange: { min: 100, max: 200 } }).svg).map(Number);
    expect(labels).toContain(200);
    expect(labels.every((label) => label >= 90 && label <= 210)).toBe(true);
  });

  it("横軸の範囲が小数3桁より狭くても、目盛りは重ならずに並ぶ", () => {
    const labels = tickLabels(
      renderEditor({
        breakpoints: [
          [0, 0],
          [0.004, 100],
        ],
        xRange: { min: 0, max: 0.004 },
      }).svg,
    );
    expect(labels.length).toBeGreaterThan(1);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("下限の同じ階級（幅0の階級と、そこから始まる階級）も、それぞれ棒にする", () => {
    const { svg } = renderEditor({
      distribution: distribution({
        bins: [
          [2, 2, 0.5],
          [2, 8, 0.5],
        ],
      }),
    });
    expect(svg.querySelectorAll("rect")).toHaveLength(2);
  });

  it("表示範囲の外にある延長は、しきい値以上なら左右に割合で出し、しきい値未満なら出さない", () => {
    const outside = 0.3;
    const { svg, unmount } = renderEditor({
      distribution: distribution({
        bins: [
          [-10, -5, outside],
          [2, 8, 1 - outside * 2],
          [20, 30, outside],
        ],
      }),
    });
    expect(svg).toHaveTextContent(`←${(outside * 100).toFixed(0)}%`);
    expect(svg).toHaveTextContent(`${(outside * 100).toFixed(0)}%→`);
    unmount();

    const tiny = OFF_RANGE_NOTICE_THRESHOLD / 2;
    const second = renderEditor({
      distribution: distribution({
        bins: [
          [-10, -5, tiny],
          [2, 8, 1 - tiny],
        ],
      }),
    });
    expect(second.svg).not.toHaveTextContent("←");
  });
});
