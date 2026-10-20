/**
 * `components/BottomSheet/BottomSheet.tsx`——スマホの下からせり上がるシートと、高さを範囲へ寄せる`clampSheetHeightVh`、
 * 利用者が決めた高さを覚える`useChosenSheetHeight`。
 *
 * 見るもの: 開いている間だけ見出しを名前に持つダイアログとして出すこと、閉じ方
 * （✕・Esc・下スワイプ）と閉じない操作（シートの外を押す・閉じないスワイプ・シートの中から開いた窓の上のEsc）、高さを変える帯（いまの高さの表示・ドラッグ・矢印キー）で
 * 変わる高さと確定として上げる高さ、開いたときに中身へ高さを合わせること（下端の印の要素があるとき・合わせ直す時機・決めた高さがあるとき・実寸が取れないとき）、
 * 決めた高さを覚えて次に開いたときに使うこと（保存値の読み方・動かしている途中は覚えないこと・動かす間に持ち主を描き直さないこと）。
 *
 * ここで見ないもの: 2枚のシートで高さを分け合うこと → `app/page.tsx`。シートの中身・見出しの脇の差し込み——受け取ったものを
 * そのまま置くだけ。帯が出す変えられる範囲——寄せる範囲と同じ定数を出すだけ。範囲の両側へ寄せること——`clampSheetHeightVh`の
 * テストが見る（シートの側は、寄せた値を出すことを片側で見る）。ルートを地図へ収めるときにシートを避けること——実寸が要るので
 * `e2e/mobile.spec.ts`。
 *
 * 中身の高さ・シートの高さはテスト環境に無いレイアウトの実寸なので、使うテストだけ`getBoundingClientRect`と
 * `clientHeight`をテストが決める。画面の高さはテスト環境の`window.innerHeight`をそのまま使う。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "@/components/ui/Dialog/Dialog";
import BottomSheet, {
  clampSheetHeightVh,
  DEFAULT_SHEET_HEIGHT_VH,
  SHEET_FIT_END_ATTRIBUTE,
  useChosenSheetHeight,
} from "./BottomSheet";

type Props = React.ComponentProps<typeof BottomSheet>;

/** 高さの下限・上限。値を書き写さず、範囲の外の値を寄せた結果として取る（書き写すと、範囲を変えたときに
 * テストも一緒に動き、寄せることを誰も見なくなる）。 */
const FLOOR = clampSheetHeightVh(0);
const CEILING = clampSheetHeightVh(100);

const HEIGHT_STORAGE_KEY = "ridecompass:mobile-sheet-height-vh";

function sheetElement(props: Partial<Props>, handlers: Pick<Props, "onClose" | "onHeightChoose">) {
  return (
    <BottomSheet
      open
      title="ルート設定"
      titleId="sheet-title"
      headerAction={null}
      chosenHeightVh={50}
      {...handlers}
      {...props}
    >
      <p>中身</p>
    </BottomSheet>
  );
}

function renderSheet(props: Partial<Props> = {}) {
  const handlers = { onClose: vi.fn(), onHeightChoose: vi.fn() };
  const view = render(sheetElement(props, handlers));
  let current = props;
  return {
    ...handlers,
    /** 前に渡したpropsへ`next`を重ねて描き直す。 */
    rerender: (next: Partial<Props>) => {
      current = { ...current, ...next };
      view.rerender(sheetElement(current, handlers));
    },
    container: view.container,
  };
}

/** `useChosenSheetHeight`で決めた高さを持ち、シートへ渡す持ち主。描くたびに`onRender`を呼ぶ。 */
function OwnedSheet({ onRender }: { onRender: () => void }) {
  const [chosenHeightVh, chooseHeight] = useChosenSheetHeight();
  onRender();
  return (
    <BottomSheet
      open
      title="ルート設定"
      titleId="sheet-title"
      headerAction={null}
      onClose={() => {}}
      chosenHeightVh={chosenHeightVh}
      onHeightChoose={chooseHeight}
    >
      <p>中身</p>
    </BottomSheet>
  );
}

function handle() {
  return screen.getByRole("separator", { name: "パネルの高さを変更" });
}

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
      fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 500 });
      onHeightChoose.mockClear();
      fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 300 });

      expect(handle()).toHaveAttribute("aria-valuenow", "50");
      expect(onHeightChoose).not.toHaveBeenCalled();
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

  describe("中身に合わせた高さ", () => {
    /** 高さの指定を外したときだけ中身の高さを、それ以外はシートの箱の高さを返す実寸。 */
    function stubLayout(naturalPx: number, boxPx = 300) {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        return new DOMRect(0, 0, 300, this.style.height === "auto" ? naturalPx : boxPx);
      });
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(boxPx);
    }

    it("高さを決めていなければ、開くと高さの指定を外して測った中身の高さを画面の割合（切り上げ）にして使い、確定としては上げない", () => {
      stubLayout(window.innerHeight * 0.333);

      const { onHeightChoose } = renderSheet({ chosenHeightVh: null });

      expect(screen.getByRole("dialog").style.height).toBe("34vh");
      expect(handle()).toHaveAttribute("aria-valuenow", "34");
      expect(onHeightChoose).not.toHaveBeenCalled();
    });

    it.each([
      ["印の下端が中身の終わりより上なら、印の下端まで", 0.6, 0.3, "30"],
      ["印の下端が中身の終わりより下なら、中身の高さ", 0.25, 0.4, "25"],
    ])("中身に下端の印の要素があれば、開いたときに合わせる高さは%s", (_, naturalShare, endShare, expected) => {
      const naturalPx = window.innerHeight * naturalShare;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute(SHEET_FIT_END_ATTRIBUTE)) return new DOMRect(0, 0, 300, window.innerHeight * endShare);
        return new DOMRect(0, 0, 300, this.style.height === "auto" ? naturalPx : 300);
      });
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);

      render(
        <BottomSheet
          open
          title="ルート結果"
          titleId="sheet-title"
          headerAction={null}
          onClose={() => {}}
          chosenHeightVh={null}
          onHeightChoose={() => {}}
        >
          <div {...{ [SHEET_FIT_END_ATTRIBUTE]: "" }}>グラフ</div>
          <p>内訳</p>
        </BottomSheet>,
      );

      expect(handle()).toHaveAttribute("aria-valuenow", expected);
    });

    it("中身が高いときも、範囲の中に留める", () => {
      stubLayout(window.innerHeight * ((CEILING + 100) / 200));

      renderSheet({ chosenHeightVh: null });

      expect(handle()).toHaveAttribute("aria-valuenow", String(CEILING));
    });

    it("開いている間は合わせ直さず、中身が別物になった（fitKeyが変わった）ときと開き直したときに合わせ直す", () => {
      stubLayout(window.innerHeight * 0.3);
      const { rerender } = renderSheet({ chosenHeightVh: null, fitKey: "設定" });

      stubLayout(window.innerHeight * 0.6);
      rerender({ title: "ルート設定（変更）" });
      expect(handle()).toHaveAttribute("aria-valuenow", "30");

      stubLayout(window.innerHeight * 0.75);
      rerender({ fitKey: "結果" });
      expect(handle()).toHaveAttribute("aria-valuenow", "75");

      stubLayout(window.innerHeight * 0.25);
      rerender({ open: false });
      rerender({ open: true });
      expect(handle()).toHaveAttribute("aria-valuenow", "25");
    });

    it("高さを決めてあるときは、開いても中身に合わせずその高さを使う", () => {
      stubLayout(window.innerHeight * 0.3);

      renderSheet({ chosenHeightVh: 60 });

      expect(handle()).toHaveAttribute("aria-valuenow", "60");
    });

    it("実寸が取れないとき（テスト環境のまま）は、既定の高さで開く", () => {
      renderSheet({ chosenHeightVh: null });

      expect(handle()).toHaveAttribute("aria-valuenow", String(DEFAULT_SHEET_HEIGHT_VH));
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
      ["数として読めない", "高い", DEFAULT_SHEET_HEIGHT_VH],
      ["数でない値", '"70"', DEFAULT_SHEET_HEIGHT_VH],
      ["シートの範囲の外", "500", CEILING],
    ])("保存されたシートの高さが%s（%s）なら、%dvhで開く", (_, stored, expected) => {
      window.localStorage.setItem(HEIGHT_STORAGE_KEY, stored);

      render(<OwnedSheet onRender={() => {}} />);

      expect(handle()).toHaveAttribute("aria-valuenow", String(expected));
    });
  });
});
