/**
 * `components/FirstVisitIntro/FirstVisitIntro.tsx`——初めて開いたときに地図の上に出す案内と、閉じたかを覚えるフック。
 *
 * 見るもの: 閉じたことが無ければ見出しを名前に持つ案内を出すこと、最初の一手の場所をスマホとPCで言い分けること、
 * 位置が分からないと分かったら出発地の行を「ルート設定」を開いて地図をタップする手順にすること、
 * ✕と「はじめる」のどちらで閉じても消え、この端末では次に開いても出ず、もう一度出す操作で出ること。
 *
 * ここで見ないもの:
 * - 目的・出発地の印・使い方の場所の文言——部品の宣言で、書き写して突き合わせるだけになる
 * - 保存値の読み書きと、読めない値のエラー → `hooks/useStoredState.ts`
 * - ヘッダーのメニューから出し直すこと → `app/page.test.tsx`
 * - マウントするまで出さないこと（サーバーで描いたHTMLに載せない）——テスト環境の`render`はマウントまで同期で進み、
 *   マウント前の描画を取り出せない
 *
 * 閉じたことはテスト環境の`localStorage`に置く。テストをまたいで残るので、テストごとに空にする。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import FirstVisitIntro, { useFirstVisitIntro } from "./FirstVisitIntro";

/** フックを通した案内と、もう一度出すボタン（ページがメニューから渡すのと同じ口を、テストが押せる形にする）。 */
function Intro({ isMobile = false, locationUnknown = false }) {
  const { shown, close, reopen } = useFirstVisitIntro();
  return (
    <>
      <FirstVisitIntro shown={shown} onClose={close} isMobile={isMobile} locationUnknown={locationUnknown} />
      <button onClick={reopen}>もう一度出す</button>
    </>
  );
}

function intro() {
  return screen.queryByRole("region", { name: "RideCompass" });
}

afterEach(() => {
  localStorage.clear();
});

describe("FirstVisitIntro", () => {
  it.each([
    [true, "下の「ルート設定」を開いて距離を決め、ルート生成を押すと、ルートの候補が地図に出ます。"],
    [false, "左の「ルート設定」で距離を決め、ルート生成を押すと、ルートの候補が地図に出ます。"],
  ])("スマホ（%s）かで、最初の一手の場所を言い分ける", (isMobile, firstStep) => {
    render(<Intro isMobile={isMobile} />);

    expect(screen.getByText(/ルートの候補が地図に出ます/)).toHaveTextContent(firstStep);
  });

  it.each([
    [false, "この印が出発地です[はじめは現在地]。地図の上でつかんで動かせます。"],
    [
      true,
      "現在地が分からないため、この灰色の印は仮の地点です。「ルート設定」を開いて地図をタップすると、そこが出発地になります。",
    ],
  ])("位置が分からないと分かったか（%s）で、出発地の行を言い分ける", (locationUnknown, originLine) => {
    render(<Intro locationUnknown={locationUnknown} />);

    expect(screen.getByText(/が出発地/)).toHaveTextContent(originLine);
  });

  it.each(["案内を閉じる", "はじめる"])(
    "「%s」を押すと消え、次に開いても出ず、もう一度出す操作で出る",
    async (name) => {
      const view = render(<Intro />);
      expect(intro()).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name }));

      expect(intro()).not.toBeInTheDocument();
      view.unmount();
      render(<Intro />);
      expect(intro()).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "もう一度出す" }));
      expect(intro()).toBeInTheDocument();
    },
  );
});
