/**
 * `features/route/RouteAxisProfile/RouteAxisProfile.tsx`——候補の中身の所要・負担と、負担の内訳（帯と軸ごとの行）・事実。
 *
 * 見るもの: 所要と負担の数（分へ丸め）と、無いときの省き方、所要時間の前提が崩れたことの注記（風・値の無い区間の割合を
 * 丸めて1%以上）、内訳の行（軸の名前・その軸の事実・負担の分、回避指定の行）、内訳が無い候補で事実だけを出すこと、標高の無い
 * 道の注記。
 *
 * ここで見ないもの: 所要の書き方 → `lib/duration.ts`。内訳の行の並べ方 → `lib/routePenalty.ts`。区間の内訳も同じ部品
 * （`features/route/PenaltyBreakdown/PenaltyBreakdown.tsx`）を通る。
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import RouteAxisProfile from "./RouteAxisProfile";

const CATALOG = {
  axes: [
    { axisId: "ascent", label: "登坂" },
    { axisId: "vibration", label: "振動" },
  ],
  axisColors: {},
  avoidanceLabel: "回避指定",
  loaded: true,
  failed: false,
};

type Props = React.ComponentProps<typeof RouteAxisProfile>;

function renderProfile(props: Partial<Props> = {}) {
  return render(
    <RouteAxisProfile
      penalty={{
        axis_seconds: { ascent: 300, vibration: 0 },
        avoidance_seconds: 120,
        total_seconds: 420,
      }}
      facts={{
        elevation_unknown_km: 0,
        axes: {
          ascent: { label: "登り", value: 240, unit: "m" },
          vibration: { label: "振動のある道", value: 1.25, unit: "km" },
        },
      }}
      catalog={CATALOG}
      estimatedDurationSeconds={3720}
      missingTravelDataShare={null}
      {...props}
    />,
  );
}

const rows = () =>
  within(screen.getByRole("list"))
    .getAllByRole("listitem")
    .map((item) => item.textContent);

describe("RouteAxisProfile", () => {
  it("所要と負担（内訳の和）を分で並べ、それぞれに(i)の説明を持つ", () => {
    renderProfile();
    expect(screen.getByText("所要").parentElement).toHaveTextContent("所要62分");
    expect(screen.getByText("負担").parentElement).toHaveTextContent("負担+7分");
    for (const name of ["所要時間の説明を表示", "負担の説明を表示"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("内訳は軸を一覧の順に、名前・その軸の事実・負担の分で並べ、回避指定を後ろに置き、帯は秒のある行だけで描く", () => {
    renderProfile({
      penalty: {
        axis_seconds: { ascent: 300, vibration: 0 },
        avoidance_seconds: 120,
        total_seconds: 420,
      },
    });
    expect(rows()).toEqual(["登坂登り 240m+5分", "振動振動のある道 1.3km+0分", "回避指定+2分"]);
    expect(screen.getByRole("img", { name: "負担の内訳" }).children).toHaveLength(2);
  });

  it("所要時間が無い候補では所要を出さない", () => {
    renderProfile({ estimatedDurationSeconds: null });
    expect(screen.queryByText("所要")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "所要時間の説明を表示" })).not.toBeInTheDocument();
  });

  it("標高の無い道があれば、その長さを登りに数えていないと注記する", () => {
    const { unmount } = renderProfile({ facts: { elevation_unknown_km: 0.4, axes: {} } });
    expect(screen.getByText("標高の無い道 0.4km（登りに数えていません）")).toBeInTheDocument();
    unmount();
    renderProfile();
    expect(screen.queryByText(/標高の無い道/)).not.toBeInTheDocument();
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
