/**
 * `features/route/RouteAxisProfile/RouteAxisProfile.tsx`——候補の中身の所要・負担。
 *
 * 見るもの: 所要と負担の数（分へ丸め）と、無いときの省き方、所要時間の前提が崩れたことの注記（値の無い区間の割合を
 * 丸めて1%以上）。
 *
 * ここで見ないもの: 所要の書き方 → `lib/duration.ts`。負担の種類ごとの内訳と事実 → 道のりのグラフの一覧
 * （`features/route/RouteProfile/RouteProfile.test.tsx`）。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import RouteAxisProfile from "./RouteAxisProfile";

type Props = React.ComponentProps<typeof RouteAxisProfile>;

function renderProfile(props: Partial<Props> = {}) {
  return render(
    <RouteAxisProfile
      penalty={{
        axis_seconds: { ascent: 300, vibration: 0 },
        avoidance_seconds: 120,
        total_seconds: 420,
      }}
      estimatedDurationSeconds={3720}
      missingTravelDataShare={null}
      {...props}
    />,
  );
}

describe("RouteAxisProfile", () => {
  it("所要と負担（内訳の和）を分で並べ、それぞれに(i)の説明を持つ", () => {
    renderProfile();
    expect(screen.getByText("所要").parentElement).toHaveTextContent("所要62分");
    expect(screen.getByText("負担").parentElement).toHaveTextContent("負担+7分");
    for (const name of ["所要時間の説明を表示", "負担の説明を表示"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("所要時間が無い候補では所要を出さない", () => {
    renderProfile({ estimatedDurationSeconds: null });
    expect(screen.queryByText("所要")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "所要時間の説明を表示" })).not.toBeInTheDocument();
  });

  it.each([
    [null, null],
    [0.004, null],
    [0.012, `データの無い区間が1%[${routeGenerateConfig.missing_travel_data_wording}]`],
  ])("値の無い区間の割合が%sなら、注記は%s（百分率へ丸めて1以上のときだけ出す）", (share, expected) => {
    renderProfile({ missingTravelDataShare: share });
    if (expected === null) expect(screen.queryByText(/データの無い区間が/)).not.toBeInTheDocument();
    else expect(screen.getByText(expected)).toBeInTheDocument();
  });
});
