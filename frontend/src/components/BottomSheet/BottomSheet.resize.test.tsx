/**
 * `components/BottomSheet/BottomSheet.tsx`の高さを変える帯と、利用者が決めた高さを覚える`useChosenSheetHeight`。
 *
 * 見るもの: 帯（いまの高さの表示・ドラッグ・矢印キー）で変わる高さと確定として上げる高さ（押しただけ・取り上げられたときは上げない）、決めた高さを覚えて次に開いたときに
 * 使うこと（保存値の読み方・動かしている途中は覚えないこと・動かす間に持ち主を描き直さないこと）。
 *
 * ここで見ないもの: 帯が出す変えられる範囲——寄せる範囲と同じ定数を出すだけ。範囲の両側へ寄せること——`clampSheetHeightVh`の
 * テスト（`BottomSheet.test.tsx`）が見る（帯の側は、寄せた値を出すことを片側で見る）。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CEILING, handle, renderSheet } from "@/testing/bottomSheet";
import BottomSheet, { DEFAULT_SHEET_HEIGHT_VH, useChosenSheetHeight } from "./BottomSheet";

const HEIGHT_STORAGE_KEY = "ridecompass:mobile-sheet-height-vh";

/** `useChosenSheetHeight`で決めた高さを持ち、シートへ渡す持ち主。描くたびに`onRender`を呼ぶ。 */
function OwnedSheet({ onRender }: { onRender: () => void }) {
  const [chosenHeightVh, chooseHeight] = useChosenSheetHeight();
  onRender();
  return (
    <BottomSheet
      open
      title="ルート設定"
      headerAction={null}
      onClose={() => {}}
      chosenHeightVh={chosenHeightVh}
      onHeightChoose={chooseHeight}
    >
      <p>中身</p>
    </BottomSheet>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("BottomSheet", () => {
  describe("高さを変える帯", () => {
    it("いまの高さを整数にして出す", () => {
      renderSheet({ chosenHeightVh: 42.6 });

      expect(handle()).toHaveAttribute("aria-valuenow", "43");
    });

    it("つまんで上へ動かす間は持ち主を描き直さずに動いたぶんシートだけを高くし、離すとその高さを確定として上げる", () => {
      const onRender = vi.fn();
      render(<OwnedSheet onRender={onRender} />);
      onRender.mockClear();
      const moved = window.innerHeight / 4;

      fireEvent.pointerDown(handle(), { pointerId: 1, clientY: 500 });
      fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 500 - moved / 2 });
      fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 500 - moved });
      expect(handle()).toHaveAttribute("aria-valuenow", String(DEFAULT_SHEET_HEIGHT_VH + 25));
      expect(screen.getByRole("dialog").style.height).toBe(`${DEFAULT_SHEET_HEIGHT_VH + 25}vh`);
      expect(onRender).not.toHaveBeenCalled();
      fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 500 - moved });

      expect(onRender).toHaveBeenCalled();
      expect(handle()).toHaveAttribute("aria-valuenow", String(DEFAULT_SHEET_HEIGHT_VH + 25));
    });

    it("上へ大きく動かしても、範囲の中に留める", () => {
      const { onHeightChoose } = renderSheet({ chosenHeightVh: 50 });

      fireEvent.pointerDown(handle(), { pointerId: 1, clientY: 400 });
      fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 400 - window.innerHeight });
      fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 400 - window.innerHeight });

      expect(onHeightChoose.mock.calls).toEqual([[CEILING]]);
    });

    it("つまんだ指と別の指の動きと離しは無視する", () => {
      const { onHeightChoose } = renderSheet({ chosenHeightVh: 50 });

      fireEvent.pointerDown(handle(), { pointerId: 1, clientY: 500 });
      fireEvent.pointerMove(handle(), { pointerId: 2, clientY: 300 });
      fireEvent.pointerUp(handle(), { pointerId: 2, clientY: 300 });

      expect(handle()).toHaveAttribute("aria-valuenow", "50");
      expect(onHeightChoose).not.toHaveBeenCalled();
    });

    it("つままずに動かしたり離したりしても何も変えず、離したあとの動きも無視する", () => {
      const { onHeightChoose } = renderSheet({ chosenHeightVh: 50 });

      fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 300 });
      fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 300 });
      expect(onHeightChoose).not.toHaveBeenCalled();
      fireEvent.pointerDown(handle(), { pointerId: 1, clientY: 500 });
      fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 400 });
      onHeightChoose.mockClear();
      fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 300 });

      expect(onHeightChoose).not.toHaveBeenCalled();
    });

    it("離した位置から高さを決める（最後の動きのあとに指が進んでいても）", () => {
      const { onHeightChoose } = renderSheet({ chosenHeightVh: 50 });
      const moved = window.innerHeight / 4;

      fireEvent.pointerDown(handle(), { pointerId: 1, clientY: 500 });
      fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 500 - moved / 2 });
      fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 500 - moved });

      expect(onHeightChoose.mock.calls).toEqual([[75]]);
    });

    it.each([
      [
        "動かさずに離した（押しただけ）",
        (pointerId: number) => fireEvent.pointerUp(handle(), { pointerId, clientY: 503 }),
      ],
      ["動かしている途中で端末が取り上げた", (pointerId: number) => fireEvent.pointerCancel(handle(), { pointerId })],
    ])("つまみを%sときは高さを決めず、つまむ前の中身に合わせた高さへ戻す", (_, end) => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        return new DOMRect(0, 0, 300, this.style.height === "auto" ? window.innerHeight * 0.333 : 300);
      });
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
      const { onHeightChoose } = renderSheet({ chosenHeightVh: null });

      fireEvent.pointerDown(handle(), { pointerId: 1, clientY: 500 });
      fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 400 });
      end(1);

      expect(onHeightChoose).not.toHaveBeenCalled();
      expect(handle()).toHaveAttribute("aria-valuenow", "34");
    });

    /** 帯にフォーカスしてキーを押し、確定として上がった高さを返す。 */
    async function pressOnHandle(key: string, from: number) {
      const { onHeightChoose, container } = renderSheet({ chosenHeightVh: from });
      handle().focus();
      await userEvent.keyboard(key);
      const chosen = onHeightChoose.mock.calls;
      container.remove();
      return chosen;
    }

    it("上の矢印と下の矢印は同じ幅だけ高さを上げ下げし、確定として上げる", async () => {
      const up = await pressOnHandle("{ArrowUp}", 50);
      const down = await pressOnHandle("{ArrowDown}", 50);

      expect(up[0][0]).toBeGreaterThan(50);
      expect(50 - down[0][0]).toBe(up[0][0] - 50);
    });

    it("上限の近くで上の矢印を押しても、範囲の中に留める", async () => {
      expect(await pressOnHandle("{ArrowUp}", CEILING - 0.5)).toEqual([[CEILING]]);
    });

    it("矢印の上下以外のキーでは何も上げない", async () => {
      const { onHeightChoose } = renderSheet();
      handle().focus();

      await userEvent.keyboard("{ArrowLeft}");

      expect(onHeightChoose).not.toHaveBeenCalled();
    });
  });

  describe("決めた高さを覚える", () => {
    it("つまんで動かしている途中で閉じた高さは覚えず、離して決めた高さは次に開いたときも使う", () => {
      const first = render(<OwnedSheet onRender={() => {}} />);
      fireEvent.pointerDown(handle(), { pointerId: 1, clientY: window.innerHeight * 0.5 });
      fireEvent.pointerMove(handle(), { pointerId: 1, clientY: window.innerHeight * 0.3 });
      expect(handle()).toHaveAttribute("aria-valuenow", "70");
      first.unmount();

      const second = render(<OwnedSheet onRender={() => {}} />);
      expect(handle()).toHaveAttribute("aria-valuenow", String(DEFAULT_SHEET_HEIGHT_VH));
      fireEvent.pointerDown(handle(), { pointerId: 1, clientY: window.innerHeight * 0.5 });
      fireEvent.pointerMove(handle(), { pointerId: 1, clientY: window.innerHeight * 0.3 });
      fireEvent.pointerUp(handle(), { pointerId: 1, clientY: window.innerHeight * 0.3 });
      second.unmount();

      render(<OwnedSheet onRender={() => {}} />);
      expect(handle()).toHaveAttribute("aria-valuenow", "70");
    });

    it.each([
      ["数でない値", '"70"', DEFAULT_SHEET_HEIGHT_VH],
      ["シートの範囲の外", "500", CEILING],
    ])("保存されたシートの高さが%s（%s）なら、%dvhで開く", (_, stored, expected) => {
      window.localStorage.setItem(HEIGHT_STORAGE_KEY, stored);

      render(<OwnedSheet onRender={() => {}} />);

      expect(handle()).toHaveAttribute("aria-valuenow", String(expected));
    });
  });
});
