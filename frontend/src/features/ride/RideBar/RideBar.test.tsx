/**
 * 走りの帯（`features/ride/RideBar/RideBar.tsx`）——走行モードの間、画面の上の1行にルートの残り・到着予想・今の速さ・風を出す。
 *
 * ここで見ないもの:
 * - 走行モードの間だけ天気の帯の代わりに出ること・ルートを外れている間だけ外れたと出すこと → `app/page.ride.test.tsx`
 * - 残りと到着予想の出し方 → `rideRemaining.test.ts`
 * - 風の矢印を地図の向きに合わせて回すこと → `features/conditions/WeatherPanel/WeatherPanel.test.tsx`
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import RideBar from "./RideBar";

const bar = () => screen.getByRole("group", { name: "走りの数字" });

type Props = Parameters<typeof RideBar>[0];

function props(overrides: Partial<Props> = {}): Props {
  return { remaining: null, offRoute: false, mapBearingDeg: 0, speedKmh: null, wind: null, ...overrides };
}

describe("RideBar", () => {
  it.each([
    { case: "速さがあれば時速の整数で出す", speedKmh: 18.4, text: "18km/h" },
    { case: "速さが無ければ、無いことを出す", speedKmh: null, text: "—km/h" },
  ])("$case", ({ speedKmh, text }) => {
    render(<RideBar {...props({ speedKmh })} />);
    expect(bar()).toHaveTextContent(text);
  });

  it("風があれば向きと速さを出し、無ければ出さない", () => {
    const { rerender } = render(
      <RideBar {...props({ wind: { directionDeg: 180, directionLabel: "南", speedMs: 3.24 } })} />,
    );
    expect(bar()).toHaveTextContent("南の風");
    expect(bar()).toHaveTextContent("3.2m/s");

    rerender(<RideBar {...props()} />);
    expect(bar()).not.toHaveTextContent("の風");
  });

  it.each([
    {
      case: "ルートの残りがあれば、残りの距離を小数1桁で、到着予想を日本時間の時刻で出す",
      remaining: { remainingKm: 12.34, arrivalAt: new Date("2026-10-13T05:07:00Z") },
      texts: ["残り: 12.3km", "到着予想: 14:07"],
      absent: [],
    },
    {
      case: "現在地をまだルートへ当てていなければ、無いことを出す",
      remaining: { remainingKm: null, arrivalAt: null },
      texts: ["残り: —km", "到着予想: —"],
      absent: [],
    },
    {
      case: "選んだ候補が無ければ、残りも到着予想も出さない",
      remaining: null,
      texts: [],
      absent: ["残り", "到着予想"],
    },
  ])("$case", ({ remaining, texts, absent }) => {
    render(<RideBar {...props({ remaining })} />);
    for (const text of texts) expect(bar()).toHaveTextContent(text);
    for (const text of absent) expect(bar()).not.toHaveTextContent(text);
  });
});
