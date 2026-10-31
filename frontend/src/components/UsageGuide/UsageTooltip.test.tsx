/**
 * `components/UsageGuide/UsageTooltip.tsx`——アイコンだけの部品を長押し（マウスは重ねる）すると、名前と使い方を吹き出しで出す。
 * どの部品をアイコンだけと数えるかを引く`usageTarget.ts`は、この部品の中の手順として通す。
 *
 * 見るもの: タッチの長押しで出ることと、そのあとの押し操作が部品へ届かないこと（キーで押したものは届くこと）、短く押す・動かすと出さず押した扱いのままなこと、
 * 文字を出す部品・つまみは出さないこと（件数の札のように読み上げから隠した文字はアイコンだけに数える）、使い方の文が無ければ名前だけ、
 * タッチで出したものはほかを押すまで残ること、マウスを重ねると出て外す・押すと消えること。
 *
 * ここで見ないもの:
 * - 吹き出しの置き方 → Radixの位置取りに任せている
 * - 説明を見る状態（`UsageGuide.tsx`）の間はこの部品を置かないこと → 置く側（`app/HomeMapPane.tsx`。`app/page.tsx`のテストが見る）
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/Button/Button";
import UsageTooltip, { LONG_PRESS_MS } from "./UsageTooltip";

function renderScreen() {
  const onGenerate = vi.fn();
  const onSave = vi.fn();
  render(
    <div>
      <Button size="panelIcon" aria-label="ルート生成" onClick={onGenerate} usage="いまの条件で候補を作ります。">
        <svg aria-hidden="true" />
      </Button>
      <Button size="panelIcon" aria-label="グラフに出す情報" usage="グラフに重ねる情報を選びます。">
        <svg aria-hidden="true" />
        <span aria-hidden="true">3</span>
      </Button>
      <button type="button" aria-label="現在地へ移動">
        <svg aria-hidden="true" />
      </button>
      <Button onClick={onSave} usage="いまの設定を保存します。">
        <svg aria-hidden="true" />
        保存
      </Button>
      <div role="slider" aria-label="重み" aria-valuenow={3} tabIndex={0} data-usage="重みを決めます。" />
      <p>本文の文字</p>
      <UsageTooltip />
    </div>,
  );
  return { onGenerate, onSave };
}

const button = (name: string) => screen.getByRole("button", { name });
const tooltip = () => screen.queryByRole("tooltip");

function touchDown(element: Element, at = { clientX: 10, clientY: 10 }) {
  fireEvent.pointerDown(element, { pointerType: "touch", button: 0, ...at });
}

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** 指を離したあとにブラウザが送る、押した扱いの出来事。 */
function release(element: Element) {
  fireEvent.pointerUp(element, { pointerType: "touch", button: 0 });
  fireEvent.mouseDown(element);
  fireEvent.mouseUp(element);
  fireEvent.click(element);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("UsageTooltip", () => {
  it("アイコンを長押しすると名前と使い方を出し、離しても押した扱いにしない。出したものはほかを押すまで残る", () => {
    const { onGenerate } = renderScreen();

    touchDown(button("ルート生成"));
    wait(LONG_PRESS_MS - 1);
    expect(tooltip()).toBeNull();
    wait(1);
    expect(tooltip()).toHaveTextContent("ルート生成");
    expect(tooltip()).toHaveTextContent("いまの条件で候補を作ります。");

    release(button("ルート生成"));
    expect(onGenerate).not.toHaveBeenCalled();
    wait(LONG_PRESS_MS * 4);
    expect(tooltip()).not.toBeNull();

    // 次の押し方（短く押す）は止めない。
    touchDown(screen.getByText("本文の文字"));
    expect(tooltip()).toBeNull();
    touchDown(button("ルート生成"));
    release(button("ルート生成"));
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it("長押しで出したあと、次に押す前でもキーで押した（ポインタを伴わない）clickは部品へ届く", () => {
    const { onGenerate } = renderScreen();
    touchDown(button("ルート生成"));
    wait(LONG_PRESS_MS);
    release(button("ルート生成"));

    fireEvent.keyDown(button("ルート生成"), { key: "Enter" });
    fireEvent.click(button("ルート生成"));

    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["長押しの前に離す", (element: Element) => fireEvent.pointerUp(element, { pointerType: "touch" })],
    [
      "指を動かす（なぞる）",
      (element: Element) => fireEvent.pointerMove(element, { pointerType: "touch", clientX: 30, clientY: 10 }),
    ],
    [
      "押し方が取り消される（スクロールになった）",
      (element: Element) => fireEvent.pointerCancel(element, { pointerType: "touch" }),
    ],
  ])("%sと出さない", (_, interrupt) => {
    renderScreen();

    touchDown(button("ルート生成"));
    wait(LONG_PRESS_MS / 2);
    interrupt(button("ルート生成"));
    wait(LONG_PRESS_MS);

    expect(tooltip()).toBeNull();
  });

  it.each([
    ["文字を出すボタン", () => button("保存")],
    ["つまみ", () => screen.getByRole("slider", { name: "重み" })],
  ])("%sは長押ししても出さない", (_, element) => {
    renderScreen();

    touchDown(element());
    wait(LONG_PRESS_MS);

    expect(tooltip()).toBeNull();
  });

  it.each([
    ["読み上げから隠した件数の札はアイコンだけに数える", "グラフに出す情報", "グラフに重ねる情報を選びます。"],
    ["使い方の文が無ければ名前だけ", "現在地へ移動", null],
  ])("%s", (_, name, usage) => {
    renderScreen();

    touchDown(button(name));
    wait(LONG_PRESS_MS);

    expect(tooltip()).toHaveTextContent(usage === null ? new RegExp(`^${name}$`) : `${name}${usage}`);
  });

  it("マウスを重ねると出し、外すと消す。押しても消す", () => {
    renderScreen();
    const generate = button("ルート生成");

    fireEvent.pointerOver(generate, { pointerType: "mouse" });
    wait(LONG_PRESS_MS);
    expect(tooltip()).toHaveTextContent("いまの条件で候補を作ります。");

    fireEvent.pointerOut(generate, { pointerType: "mouse", relatedTarget: document.body });
    expect(tooltip()).toBeNull();

    fireEvent.pointerOver(generate, { pointerType: "mouse" });
    wait(LONG_PRESS_MS);
    fireEvent.pointerDown(generate, { pointerType: "mouse", button: 0 });
    expect(tooltip()).toBeNull();
  });
});
