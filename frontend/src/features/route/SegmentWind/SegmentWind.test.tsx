/**
 * `features/route/SegmentWind/SegmentWind.tsx`——区間の詳細に出す、その区間の評価に使った風。
 *
 * 見るもの: 風の値が無ければ何も描かないこと、最寄りの格子点のどの時刻の値か（日本時間で）、方位の呼び名と風速（小数1桁）、
 * (i)の説明が数値予報モデルの値の断り（生成物の文）を添えること。
 *
 * ここで見ないもの: 角度から方位の呼び名への丸め → `lib/cardinalLabel.ts`。時刻の書き方 → `lib/time.ts`。
 * (i)の開閉と名前 → `components/ui/InfoPopover`。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { cardinalLabel } from "@/lib/cardinalLabel";
import { mapDisplay } from "@/types/generated/mapDisplay";
import type { RouteSegmentDetail } from "@/types/route";
import SegmentWind from "./SegmentWind";

type Wind = NonNullable<RouteSegmentDetail["wind"]>;

function wind(overrides: Partial<Wind> = {}): Wind {
  return { speed_ms: 0, direction_deg: 0, forecast_at: "2026-10-04T09:05", ...overrides };
}

describe("SegmentWind", () => {
  it("風の値が無い区間（backendが値を返さない）では何も描かない", () => {
    const { container } = render(<SegmentWind wind={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("最寄りの格子点の値であることと計算値の時刻を日本時間で、方位の呼び名と小数1桁の風速と並べて出す", () => {
    render(<SegmentWind wind={wind({ direction_deg: 180, speed_ms: 3.26 })} />);
    expect(screen.getByText(`最寄りの格子点の09:05の計算値: ${cardinalLabel(180)} 3.3m/s`)).toBeInTheDocument();
  });

  it("説明は、大きな誤差を含む可能性と予報ではないことを、数値予報モデルの値に添える断りの文で示す", async () => {
    // 気象庁は、数値予報モデルの値を出すならこの2つを明示するよう求める。断りの文は生成物（backendの定数）が1つだけ持つ。
    render(<SegmentWind wind={wind()} />);
    await userEvent.click(screen.getByRole("button", { name: "区間の風の説明を表示" }));
    expect(await screen.findByText(new RegExp(mapDisplay.modelValueDisclaimer))).toBeInTheDocument();
  });
});
