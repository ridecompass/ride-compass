/**
 * `components/UsageGuide/UsageGuide.tsx`——説明を見る状態（押した部品は動かず、その部品の名前と使い方を出す）。
 * 押された要素から部品と名前・使い方を引く`usageTarget.ts`は、この部品の中の手順として通す。
 *
 * 見るもの: 部品を押したときに部品が動かず説明が出ること、説明に出す名前（読み上げ名の引き方）と
 * 使い方の文（自分か囲む要素の印・無いときの文言）、ラベルを押したときに説明する入力、押せないボタンでも出ること、
 * 動かした（なぞった・取り消された）押し方と、部品の外で押し始めた押し方では出さないこと、キー操作で説明を出すこと（Enter・Space）と値を動かすキーを止めること、
 * 説明している部品を囲む枠と測り直し（替えた部品の枠を前の部品の位置に描かないこと）、マウスの操作は既定の動きまで止め、タッチは既定の動き（スクロール）を残すこと、終えたら部品が動くこと。
 *
 * ここで見ないもの:
 * - 終えることと説明を閉じること → `UsageGuide.close.test.tsx`
 * - 「中を見る」と、それで開いた浮きパネル → `UsageGuide.lookInside.test.tsx`
 * - 案内の文言——部品の宣言で、書き写して突き合わせるだけになる
 * - 共有部品が使い方の文を印に書くこと → それぞれの部品（`components/ui/Button/Button.tsx`等）。ここでは本物の
 *   `Button`で1つだけ通す
 * - 説明の面の置き方 → Radixの位置取り（`side`・`collisionPadding`）に任せている
 * - 案内をつまみで動かすこと → `components/FloatingPanel/FloatingPanel.tsx`（react-rndの振る舞い）
 *
 * 部品の実寸はテスト環境に無いレイアウトの値なので、枠を見るテストだけ`getBoundingClientRect`をテストが決める。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/Button/Button";
import { explanation, renderScreen } from "@/testing/usageGuide";
import UsageGuide from "./UsageGuide";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UsageGuide", () => {
  it("部品を押すと、部品は動かず、名前と使い方を出す", async () => {
    const { onGenerate, onEnd } = renderScreen();

    await userEvent.click(screen.getByRole("button", { name: "生成" }));

    expect(onGenerate).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(explanation()).toHaveTextContent("生成");
    expect(explanation()).toHaveTextContent("いまの条件で候補を作ります。");
  });

  it.each([
    ["読み上げの名前の指定", "地図の色分け"],
    ["名前を指す要素（複数なら空白でつなぐ）", "距離 km"],
    ["中の文字（空白はまとめる）", "地図の 明るさ ▼"],
    ["中の文字が無ければ題", "現在地へ移動"],
  ])("名前は%sから引く", async (_, name) => {
    renderScreen();

    await userEvent.click(screen.getByRole("button", { name }));

    expect(explanation()?.querySelector("p")).toHaveTextContent(name);
  });

  it("名前を引けない部品は「この部品」とし、使い方の文が無ければまだ無いと出す", async () => {
    renderScreen();

    await userEvent.click(screen.getByTestId("no-name"));

    expect(explanation()).toHaveTextContent("この部品");
    expect(explanation()).toHaveTextContent("この部品の説明はまだありません。");
  });

  it("部品の中の要素を押しても、その部品を説明する", async () => {
    renderScreen();

    await userEvent.click(screen.getByText("▼"));

    expect(explanation()?.querySelector("p")).toHaveTextContent("地図の 明るさ ▼");
  });

  it.each([
    ["入力", () => screen.getByRole("checkbox", { name: "段階1" })],
    ["ラベル", () => screen.getByText("段階1")],
  ])("%sを押すと、ラベルの文字を名前に、囲む要素の使い方を出し、入力は動かない", async (_, pressed) => {
    renderScreen();

    await userEvent.click(pressed());

    expect(explanation()?.querySelector("p")).toHaveTextContent("段階1");
    expect(explanation()).toHaveTextContent("チェックを外した段階を地図から隠します。");
    expect(screen.getByRole("checkbox", { name: "段階1" })).not.toBeChecked();
  });

  it("使い方の印を持つ素の要素も、部品として説明する", async () => {
    renderScreen();

    await userEvent.click(screen.getByText("凡例"));

    expect(explanation()).toHaveTextContent("地図の凡例です。");
  });

  it("押せないボタンでも、離したときに説明を出す", () => {
    renderScreen();
    const disabled = screen.getByRole("button", { name: "保存" });

    fireEvent.pointerDown(disabled, { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(disabled, { clientX: 0, clientY: 0 });

    expect(explanation()).toHaveTextContent("保存");
  });

  it.each([
    ["10px（ちょうど）動かして離す", 10, true],
    ["10pxより大きく動かして離す", 11, false],
  ])("%sと、説明を出すか（%s）が決まる", (_, distance, shown) => {
    renderScreen();
    const button = screen.getByRole("button", { name: "地図の色分け" });

    fireEvent.pointerDown(button, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(button, { clientX: 100 + distance * 0.6, clientY: 100 + distance * 0.8 });

    expect(explanation() !== null).toBe(shown);
  });

  it("押したあと取り消されたら、離しても説明を出さない", () => {
    renderScreen();
    const button = screen.getByRole("button", { name: "地図の色分け" });

    fireEvent.pointerDown(button, { clientX: 0, clientY: 0 });
    fireEvent.pointerCancel(button);
    fireEvent.pointerUp(button, { clientX: 0, clientY: 0 });

    expect(explanation()).not.toBeInTheDocument();
  });

  it("部品の外で押して案内の上で離したら、押し始めは捨て、のちに案内で押して部品の上で離しても説明を出さない", () => {
    renderScreen();
    const part = screen.getByRole("button", { name: "地図の色分け" });
    const guide = screen.getByRole("button", { name: "やめる" });

    fireEvent.pointerDown(screen.getByText("本文の文字"), { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(guide, { clientX: 100, clientY: 100 });
    fireEvent.pointerDown(guide, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(part, { clientX: 100, clientY: 100 });

    expect(explanation()).not.toBeInTheDocument();
  });

  describe("キー操作", () => {
    it.each(["{Enter}", " "])("フォーカスのある部品で「%s」を押すと、部品は動かず説明を出す", async (key) => {
      const { onGenerate } = renderScreen();
      screen.getByRole("button", { name: "生成" }).focus();

      await userEvent.keyboard(key);

      expect(onGenerate).not.toHaveBeenCalled();
      expect(explanation()).toHaveTextContent("いまの条件で候補を作ります。");
    });

    it("値を動かすキーは部品へ届かず、ほかのキーは届く", async () => {
      const { onPartKeyDown } = renderScreen();
      screen.getByRole("slider", { name: "重み" }).focus();

      await userEvent.keyboard("{ArrowUp}");
      expect(onPartKeyDown).not.toHaveBeenCalled();
      await userEvent.keyboard("a");

      expect(onPartKeyDown).toHaveBeenCalledTimes(1);
    });
  });

  it("説明している部品を枠で囲み、スクロールと画面の大きさが変わると測り直す", async () => {
    renderScreen();
    const button = screen.getByRole("button", { name: "地図の色分け" });
    const rect = vi.spyOn(button, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 30, 40));
    const frame = () => document.querySelector<HTMLElement>('[aria-hidden="true"][style]');
    expect(frame()).toBeNull();

    await userEvent.click(button);
    expect(frame()?.style).toMatchObject({ left: "10px", top: "20px", width: "30px", height: "40px" });

    rect.mockReturnValue(new DOMRect(10, 5, 30, 40));
    fireEvent.scroll(window);
    expect(frame()?.style.top).toBe("5px");

    rect.mockReturnValue(new DOMRect(50, 5, 30, 40));
    fireEvent(window, new Event("resize"));
    expect(frame()?.style.left).toBe("50px");
  });

  it("説明する部品を替えると、前の部品の位置には一度も枠を描かない", async () => {
    renderScreen();
    const first = screen.getByRole("button", { name: "地図の色分け" });
    const second = screen.getByRole("button", { name: "生成" });
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 30, 40));
    vi.spyOn(second, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 20, 30, 40));
    await userEvent.click(first);
    await userEvent.click(screen.getByRole("button", { name: "説明を閉じる" }));
    const drawn: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.oldValue) drawn.push(record.oldValue);
        for (const node of record.addedNodes) if (node instanceof HTMLElement) drawn.push(node.style.cssText);
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style"],
      attributeOldValue: true,
    });

    await userEvent.click(second);
    observer.disconnect();

    expect(drawn.filter((style) => style.includes("left: 10px"))).toEqual([]);
    expect(document.querySelector<HTMLElement>('[aria-hidden="true"][style]')?.style.left).toBe("200px");
  });

  it("部品の上のマウスの操作は既定の動きまで止め、タッチは部品へ届けずにスクロールを残す", () => {
    renderScreen();
    const target = screen.getByRole("button", { name: "地図の色分け" });

    expect(fireEvent.mouseDown(target)).toBe(false);
    expect(fireEvent.contextMenu(target)).toBe(false);
    expect(fireEvent.dblClick(target)).toBe(false);
    expect(fireEvent.touchStart(target, { touches: [{ clientX: 0, clientY: 0 }] })).toBe(true);
  });

  it("タッチは部品の受け口へ届かない", () => {
    const onTouchStart = vi.fn();
    render(
      <>
        <button type="button" onTouchStart={onTouchStart}>
          押す
        </button>
        <UsageGuide onEnd={vi.fn()} />
      </>,
    );

    fireEvent.touchStart(screen.getByRole("button", { name: "押す" }), { touches: [{ clientX: 0, clientY: 0 }] });

    expect(onTouchStart).not.toHaveBeenCalled();
  });

  it("説明を見る状態を外すと、部品は押したとおりに動く", async () => {
    const { onGenerate, view } = renderScreen();

    view.rerender(
      <Button onClick={onGenerate} usage="いまの条件で候補を作ります。">
        生成
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "生成" }));

    expect(onGenerate).toHaveBeenCalledTimes(1);
  });
});
