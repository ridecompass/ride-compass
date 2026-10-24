/**
 * `components/UsageGuide/UsageGuide.tsx`の「中を見る」。
 *
 * 見るもの: 閉じた展開する部品・選ばれていないタブの説明の「中を見る」（出す部品と、押せない部品等の出さない部品）、それで開いた浮きパネルの
 * 中の部品も説明し、説明の✕と終える操作では閉じないこと。
 */
import { render, screen } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import Disclosure from "@/components/Disclosure/Disclosure";
import { Button } from "@/components/ui/Button/Button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover/Popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import { explanation } from "@/testing/usageGuide";
import UsageGuide from "./UsageGuide";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UsageGuide", () => {
  describe("「中を見る」で開いた浮きパネル", () => {
    function renderPopoverScreen() {
      const onEnd = vi.fn();
      const onSpeed = vi.fn();
      function Screen() {
        const [active, setActive] = useState(true);
        return (
          <>
            <p>本文の文字</p>
            <Button usage="いまの条件で候補を作ります。">生成</Button>
            <Popover>
              <PopoverTrigger asChild>
                <Button usage="速さを決める面を開きます。">想定速度</Button>
              </PopoverTrigger>
              <PopoverContent aria-label="想定速度の面">
                <Button onClick={onSpeed} usage="速さを1つ上げます。">
                  速く
                </Button>
              </PopoverContent>
            </Popover>
            {active && (
              <UsageGuide
                onEnd={() => {
                  onEnd();
                  setActive(false);
                }}
              />
            )}
          </>
        );
      }
      render(<Screen />);
      return { onEnd, onSpeed };
    }
    const popover = () => screen.queryByRole("dialog", { name: "想定速度の面" });

    async function openInside() {
      await userEvent.click(screen.getByRole("button", { name: "想定速度" }));
      expect(popover()).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "中を見る" }));
    }

    it("開くボタンの説明の「中を見る」で開き、中の部品は動かずに説明が出て、✕でも開いたまま", async () => {
      const { onEnd, onSpeed } = renderPopoverScreen();

      await openInside();
      expect(popover()).toBeInTheDocument();
      expect(explanation()).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "速く" }));
      expect(onSpeed).not.toHaveBeenCalled();
      expect(explanation()).toHaveTextContent("速さを1つ上げます。");
      expect(explanation()).not.toHaveTextContent("中を見る");

      await userEvent.click(screen.getByRole("button", { name: "説明を閉じる" }));
      expect(popover()).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "速く" }));
      expect(explanation()).toHaveTextContent("速さを1つ上げます。");
      expect(popover()).toBeInTheDocument();
      expect(onEnd).not.toHaveBeenCalled();
    });

    it.each([
      ["「やめる」で", async () => userEvent.click(screen.getByRole("button", { name: "やめる" }))],
      ["Escで", async () => userEvent.keyboard("{Escape}")],
    ])("%s終えても、浮きパネルは開いたまま残る", async (_, operate) => {
      const { onEnd } = renderPopoverScreen();
      await openInside();

      await operate();

      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(popover()).toBeInTheDocument();
    });
  });

  describe("「中を見る」を出す部品", () => {
    it("閉じた折りたたみの見出しは「中を見る」で開き、中の部品も説明する", async () => {
      render(
        <>
          <Disclosure summary="条件" usage="条件の欄を開きます。">
            <Button usage="距離を決めます。">距離</Button>
          </Disclosure>
          <UsageGuide onEnd={vi.fn()} />
        </>,
      );
      await userEvent.click(screen.getByRole("button", { name: "条件" }));
      expect(screen.queryByRole("button", { name: "距離" })).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "中を見る" }));
      await userEvent.click(screen.getByRole("button", { name: "距離" }));

      expect(explanation()).toHaveTextContent("距離を決めます。");
    });

    it("選ばれていないタブは「中を見る」で切り替わり、中の部品も説明する", async () => {
      render(
        <>
          <Tabs defaultValue="generate">
            <TabsList>
              <TabsTrigger value="generate">条件</TabsTrigger>
              <TabsTrigger value="weights" usage="重みを決めます。">
                重み
              </TabsTrigger>
            </TabsList>
            <TabsContent value="generate" />
            <TabsContent value="weights">
              <Button usage="評価軸の重さを変えます。">勾配</Button>
            </TabsContent>
          </Tabs>
          <UsageGuide onEnd={vi.fn()} />
        </>,
      );
      await userEvent.click(screen.getByRole("tab", { name: "重み" }));
      expect(screen.queryByRole("button", { name: "勾配" })).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "中を見る" }));
      await userEvent.click(screen.getByRole("button", { name: "勾配" }));

      expect(explanation()).toHaveTextContent("評価軸の重さを変えます。");
    });

    it.each([
      ["開いている部品", { "aria-expanded": true }],
      ["選ばれているタブ", { role: "tab", "aria-selected": true }],
      ["別の面を開く部品（確かめのダイアログ等）", { "aria-expanded": false, "aria-haspopup": "dialog" as const }],
      ["押せない閉じた部品", { "aria-expanded": false, disabled: true }],
      ["押せない選ばれていないタブ", { role: "tab", "aria-selected": false, disabled: true }],
    ])("%sには出さない", async (_, attributes) => {
      render(
        <>
          <button type="button" {...attributes}>
            対象
          </button>
          <UsageGuide onEnd={vi.fn()} />
        </>,
      );

      await userEvent.click(screen.getByText("対象"));

      expect(explanation()).toHaveTextContent("対象");
      expect(screen.queryByRole("button", { name: "中を見る" })).toBeNull();
    });
  });
});
