/**
 * `components/ui/InfoPopover/InfoPopover.tsx`——見出し脇の(i)から開く短い説明の外枠。
 *
 * 見るもの: 見出しの文言をトリガーの手前に出すこと。
 *
 * ここで見ないもの: 押すと開閉し、(i)の名前が開閉に合わせて「◯◯を表示」「◯◯を隠す」になること → 使う側のテスト
 * （`features/route/RouteProfile/RouteProfile.test.tsx`等）が通す。トリガーの中身の差し替え（`triggerContent`）——ボタンの中へそのまま置くだけ。
 * 浮きパネルの置き方（`side`）——Radix Popoverの振る舞いで、テスト環境に実寸が無い。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import InfoPopover from "./InfoPopover";

describe("InfoPopover", () => {
  it("見出しを渡すと、トリガーの手前に出す", () => {
    render(
      <InfoPopover triggerAriaLabel="平均速度の説明" label="平均速度">
        説明の文
      </InfoPopover>,
    );

    const trigger = screen.getByRole("button", { name: "平均速度の説明を表示" });
    expect(trigger.parentElement).toHaveTextContent(/^平均速度/);
  });
});
