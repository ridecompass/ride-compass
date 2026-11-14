/**
 * `components/UsageGuide/UsageGuide.tsx`の終え方と説明の閉じ方。
 *
 * 見るもの: 終えるのは案内の「やめる」（押す・キー）とEscだけなこと、部品の外を押したとき（押し操作が外へ届かないことも）、
 * 説明の✕・部品の外・説明の外へのフォーカスのどれでも説明だけを閉じて部品を選ぶ続きへ戻ること。
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/Button/Button";
import { explanation, renderScreen } from "@/testing/usageGuide";
import UsageGuide from "./UsageGuide";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UsageGuide 終える・説明を閉じる", () => {
  describe("部品の外を押したとき", () => {
    it("説明を出す前なら、何もしない", async () => {
      const { onEnd } = renderScreen();

      await userEvent.click(screen.getByText("本文の文字"));

      expect(onEnd).not.toHaveBeenCalled();
      expect(explanation()).not.toBeInTheDocument();
    });

    it("説明を出している間なら、説明だけを閉じて続け、押し操作は外の要素へ届かない", async () => {
      const onMapClick = vi.fn();
      const onEnd = vi.fn();
      render(
        <>
          <Button usage="いまの条件で候補を作ります。">生成</Button>
          <div onClick={onMapClick}>地図</div>
          <UsageGuide onEnd={onEnd} />
        </>,
      );
      await userEvent.click(screen.getByRole("button", { name: "生成" }));

      await userEvent.click(screen.getByText("地図"));

      expect(explanation()).toBeNull();
      expect(onMapClick).not.toHaveBeenCalled();
      expect(onEnd).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "生成" }));
      expect(explanation()).toHaveTextContent("いまの条件で候補を作ります。");
    });
  });

  describe("キー操作", () => {
    it("Escを押すと、説明を出す前でも終える操作が上がる", async () => {
      const { onEnd } = renderScreen();

      await userEvent.keyboard("{Escape}");

      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it("描き直して終える操作が変わっても、新しいほうへ上げる", async () => {
      const onEnd = vi.fn();
      const latest = vi.fn();
      // 同じ木の形で描き直す（形が変わると部品が作り直され、新しい操作で始まるので、入れ替えを見なくなる）。
      const view = render(<UsageGuide onEnd={onEnd} />);
      view.rerender(<UsageGuide onEnd={latest} />);

      await userEvent.keyboard("{Escape}");

      expect(onEnd).not.toHaveBeenCalled();
      expect(latest).toHaveBeenCalledTimes(1);
    });

    it("案内の「やめる」を押すと（キーで押しても）、終える操作が上がる", async () => {
      const { onEnd } = renderScreen();
      screen.getByRole("button", { name: "やめる" }).focus();

      await userEvent.keyboard("{Enter}");

      expect(onEnd).toHaveBeenCalledTimes(1);
    });
  });

  it("説明の✕を押すと、説明と枠だけを閉じ、続けて別の部品の説明を出せる", async () => {
    const { onEnd, onGenerate } = renderScreen();
    const frame = () => document.querySelector<HTMLElement>('[aria-hidden="true"][style]');
    await userEvent.click(screen.getByRole("button", { name: "地図の色分け" }));
    expect(frame()).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "説明を閉じる" }));

    expect(onEnd).not.toHaveBeenCalled();
    expect(explanation()).toBeNull();
    expect(frame()).toBeNull();
    expect(screen.getByRole("button", { name: "やめる" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "生成" }));

    expect(onGenerate).not.toHaveBeenCalled();
    expect(explanation()).toHaveTextContent("いまの条件で候補を作ります。");
  });

  it("説明を出している間にフォーカスを説明の外へ移すと、説明だけを閉じる", async () => {
    const { onEnd } = renderScreen();
    await userEvent.click(screen.getByRole("button", { name: "地図の色分け" }));

    act(() => screen.getByRole("slider", { name: "重み" }).focus());

    expect(explanation()).toBeNull();
    expect(onEnd).not.toHaveBeenCalled();
  });
});
