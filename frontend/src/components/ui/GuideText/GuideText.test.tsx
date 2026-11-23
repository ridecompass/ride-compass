/**
 * `components/ui/GuideText/GuideText.tsx`——案内の文の中のボタンの名前を、アイコンにして描く。
 *
 * 見るもの: 知っているボタンの名前はかぎ括弧ごとアイコンに替わり（ボタンが文字を添えるものは同じ文字も添える）、名前は読み上げと
 * 吹き出しに残ること、知らない名前はかぎ括弧ごと文字のまま残ること。改行は段落に、続く「・」の行は1つの箇条書きになること。
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GuideText } from "./GuideText";

describe("GuideText", () => {
  it("知っているボタンの名前だけをアイコン（と、ボタンが添える文字）に替え、名前は読み上げと吹き出しに残す", () => {
    render(
      <p data-testid="guide">
        <GuideText text="「ルート設定」の「ルート生成」を押す" />
      </p>,
    );

    const mark = screen.getByTitle("ルート生成");
    expect(screen.getByTestId("guide")).toHaveTextContent(/^「ルート設定」の.*ルート生成を押す$/);
    expect(mark.querySelector("svg")).not.toBeNull();
    expect(within(mark).getByText("生成")).toHaveAttribute("aria-hidden", "true");
  });

  it("改行で段落を分け、続く「・」の行を1つの箇条書きにまとめる（行の中の名前も替える）", () => {
    render(
      <p data-testid="guide">
        <GuideText text={"頭の文です。\n・1つ目\n・「ルート生成」で作る\n間の文です。\n・2つ目の箇条書き"} />
      </p>,
    );

    const lists = screen.getAllByRole("list");
    expect(
      lists.map((list) =>
        within(list)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ),
    ).toEqual([["・1つ目", expect.stringMatching(/^・.*で作る$/)], ["・2つ目の箇条書き"]]);
    expect(within(lists[0]).getByTitle("ルート生成")).toBeInTheDocument();
    expect(screen.getByText("頭の文です。")).not.toBe(screen.getByText("間の文です。"));
    expect(screen.getByTestId("guide")).toHaveTextContent(
      /^頭の文です。・1つ目・.*で作る間の文です。・2つ目の箇条書き$/,
    );
  });
});
