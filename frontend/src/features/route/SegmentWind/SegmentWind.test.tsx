/**
 * `features/route/SegmentWind/SegmentWind.tsx`——区間の詳細に出す、その区間の評価に使った風。
 *
 * 見るもの: 風の値が無ければ何も描かないこと、どの時刻の値か（モデルの計算値の時刻を日本時間で）、
 * 方位の呼び名と風速（小数1桁）。
 *
 * ここで見ないもの: 角度から方位の呼び名への丸め → `lib/cardinalLabel.ts`。時刻の書き方 → `lib/time.ts`。
 * (i)の開閉と名前 → `components/ui/InfoPopover`。(i)の説明の文は生成物の値をそのまま差し込むだけなので見ない。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { cardinalLabel } from "@/lib/cardinalLabel";
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

  it("計算値の時刻を日本時間で、方位の呼び名と小数1桁の風速と並べて出す", () => {
    render(<SegmentWind wind={wind({ direction_deg: 180, speed_ms: 3.26 })} />);
    expect(screen.getByText(`09:05のモデルの計算値: ${cardinalLabel(180)} 3.3m/s`)).toBeInTheDocument();
  });
});
