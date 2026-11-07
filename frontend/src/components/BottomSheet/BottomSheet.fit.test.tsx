/**
 * `components/BottomSheet/BottomSheet.tsx`が開いたときに中身へ高さを合わせること（下端の印の要素があるとき・合わせ直す時機・
 * 決めた高さがあるとき・実寸が取れないとき）。
 *
 * 中身の高さ・シートの高さはテスト環境に無いレイアウトの実寸なので、使うテストだけ`getBoundingClientRect`と
 * `clientHeight`をテストが決める。画面の高さはテスト環境の`window.innerHeight`をそのまま使う。
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CEILING, handle, renderSheet } from "@/testing/bottomSheet";
import BottomSheet, { DEFAULT_SHEET_HEIGHT_VH, SHEET_FIT_END_ATTRIBUTE } from "./BottomSheet";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("BottomSheet", () => {
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
});
