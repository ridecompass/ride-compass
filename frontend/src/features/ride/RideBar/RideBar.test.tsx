/**
 * 走りの帯（`features/ride/RideBar/RideBar.tsx`）——走行モードの間、画面の上の1行に今の速さと風を出す。
 *
 * ここで見ないもの: 走行モードの間だけ天気の帯の代わりに出ること → `app/page.test.tsx`
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import RideBar from "./RideBar";

const bar = () => screen.getByRole("group", { name: "走りの数字" });

describe("RideBar", () => {
  it.each([
    { case: "速さがあれば時速の整数で出す", speedKmh: 18.4, text: "18km/h" },
    { case: "速さが無ければ、無いことを出す", speedKmh: null, text: "—km/h" },
  ])("$case", ({ speedKmh, text }) => {
    render(<RideBar speedKmh={speedKmh} wind={null} />);
    expect(bar()).toHaveTextContent(text);
  });

  it("風があれば向きと速さを出し、無ければ出さない", () => {
    const { rerender } = render(
      <RideBar speedKmh={null} wind={{ directionDeg: 180, directionLabel: "南", speedMs: 3.24 }} />,
    );
    expect(bar()).toHaveTextContent("南の風");
    expect(bar()).toHaveTextContent("3.2m/s");

    rerender(<RideBar speedKmh={null} wind={null} />);
    expect(bar()).not.toHaveTextContent("の風");
  });
});
