/**
 * `components/BottomSheet/BottomSheet.tsx`——スマホの下からせり上がるシートの出し方と閉じ方、高さを範囲へ寄せる`clampSheetHeightVh`。
 *
 * 見るもの: 開いている間だけ見出しを名前に持つダイアログとして出すこと、閉じ方
 * （✕・Esc・下スワイプ）と閉じない操作（シートの外を押す・閉じないスワイプ・シートの中から開いた窓の上のEsc）、高さを寄せる範囲。
 *
 * ここで見ないもの: 高さを変える帯と決めた高さを覚えること → `BottomSheet.resize.test.tsx`。開いたときに中身へ高さを合わせること →
 * `BottomSheet.fit.test.tsx`。2枚のシートで高さを分け合うこと → `app/page.tsx`。シートの中身・見出しの脇の差し込み——受け取ったものを
 * そのまま置くだけ。ルートを地図へ収めるときにシートを避けること——実寸が要るので`e2e/mobile.spec.ts`。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "@/components/ui/Dialog/Dialog";
import { CEILING, FLOOR, handle, renderSheet, sheetElement } from "@/testing/bottomSheet";
import BottomSheet, { clampSheetHeightVh } from "./BottomSheet";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("clampSheetHeightVh", () => {
  it("範囲の外の値はどれだけ外でも同じ下限・上限へ寄せ、範囲の中の値はそのまま通し、上限は画面いっぱい（地図を隠し切る高さ）より低い", () => {
    const inside = (FLOOR + CEILING) / 2 + 0.5;

    expect([-1000, inside, 1000].map(clampSheetHeightVh)).toEqual([FLOOR, inside, CEILING]);
    expect(FLOOR).toBeGreaterThan(0);
    expect(CEILING).toBeLessThan(100);
  });
});

describe("BottomSheet", () => {
  it("開いている間は、見出しを名前に持つダイアログを出す", () => {
    renderSheet();

    expect(screen.getByRole("dialog", { name: "ルート設定" })).toBeInTheDocument();
  });

  it("閉じている間は何も出さない", () => {
    const { container } = renderSheet({ open: false });

    expect(container).toBeEmptyDOMElement();
  });

  describe("閉じ方", () => {
    it("✕を押すと、閉じる操作が上がる", async () => {
      const { onClose } = renderSheet();

      await userEvent.click(screen.getByRole("button", { name: "閉じる" }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("シートの外の要素は押せ、押しても閉じる操作は上がらない", async () => {
      const onMapClick = vi.fn();
      const handlers = { onClose: vi.fn(), onHeightChoose: vi.fn() };
      render(
        <>
          <button type="button" onClick={onMapClick}>
            地図
          </button>
          {sheetElement({}, handlers)}
        </>,
      );

      await userEvent.click(screen.getByRole("button", { name: "地図" }));

      expect(onMapClick).toHaveBeenCalledTimes(1);
      expect(handlers.onClose).not.toHaveBeenCalled();
    });

    it("開いている間はEscで閉じる操作が上がり、ほかのキーでは上がらない", async () => {
      const { onClose } = renderSheet();

      await userEvent.keyboard("a");
      expect(onClose).not.toHaveBeenCalled();
      await userEvent.keyboard("{Escape}");

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("シートの中から開いた窓の上で押したEscは窓だけを閉じ、シートの閉じる操作は上がらない", async () => {
      const onCancel = vi.fn();
      const onClose = vi.fn();
      render(
        <BottomSheet
          open
          title="ルート結果"
          titleId="sheet-title"
          headerAction={null}
          chosenHeightVh={50}
          onClose={onClose}
          onHeightChoose={vi.fn()}
        >
          <ConfirmDialog open title="候補をすべて消します" confirmLabel="消す" onConfirm={vi.fn()} onCancel={onCancel}>
            消した候補は元に戻せません。
          </ConfirmDialog>
        </BottomSheet>,
      );

      await userEvent.keyboard("{Escape}");

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("閉じたあとはEscで閉じる操作が上がらない", async () => {
      const { onClose, rerender } = renderSheet();
      rerender({ open: false });

      await userEvent.keyboard("{Escape}");

      expect(onClose).not.toHaveBeenCalled();
    });

    function swipe(from: Element, to: Element, start: { x: number; y: number }, end: { x: number; y: number }) {
      fireEvent.touchStart(from, { touches: [{ clientX: start.x, clientY: start.y }] });
      fireEvent.touchEnd(to, { changedTouches: [{ clientX: end.x, clientY: end.y }] });
    }

    it.each([
      ["61px下へ", { x: 100, y: 361 }, 1],
      ["60px下へ（ちょうど）", { x: 100, y: 360 }, 0],
      ["横の動きのほうが大きく下へ", { x: 300, y: 400 }, 0],
    ])("見出しを%sスワイプすると、閉じる操作が%s回上がる", (_, end, times) => {
      const { onClose } = renderSheet();
      const heading = screen.getByRole("heading", { name: "ルート設定" });

      swipe(heading, heading, { x: 100, y: 300 }, end);

      expect(onClose).toHaveBeenCalledTimes(times);
    });

    it.each([
      ["中身", () => screen.getByText("中身")],
      ["高さを変える帯", handle],
    ])("%sから始めた下スワイプでは閉じない", (_, from) => {
      const { onClose } = renderSheet();

      swipe(from(), from(), { x: 100, y: 300 }, { x: 100, y: 500 });

      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
