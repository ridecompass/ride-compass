/**
 * `features/route/RouteProfile/RouteProfile.tsx`——道のりのグラフの「表示」「評価で塗る」のタブ（名前は地図の2つの入口と同じ `lib/screenNames.ts`）。
 *
 * 見るもの: 既定で「評価で塗る」（難易度のグラフ）を出すこと、その (i) が塗った軸の色と名前・値の無い区間の色・意味の文を出すこと
 * （塗る区間の無い軸は出さない）、「表示」のタブのチップが選んだ情報を重ね・外す知らせを上げること、標高の折れ線と最高・最低、
 * 選んだ地点の標高、出す情報が無いときと値が無いときの文。
 *
 * ここで見ないもの: 難易度の塗り・なぞって地点を選ぶ操作 → `DifficultyProfile.test.tsx`。折れ線の点と地点の値の計算 →
 * `profileLayers.test.ts`。選んだレイヤを覚えること → `useProfileLayers.test.ts`。
 */
import { EVALUATION_PAINT_NAME, FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { catalogEntry, catalogOf } from "@/testing/catalogAxes";
import { makeRouteSegment } from "@/testing/routeFixtures";
import type { RouteSegmentDetail } from "@/types/route";

import RouteProfile from "./RouteProfile";

const CATALOG = catalogOf([
  catalogEntry({ axis_id: "axis_a", label: "坂" }),
  catalogEntry({ axis_id: "axis_b", label: "路面" }),
]);
// 北緯35度の上を東へ1kmずつ進む2区間。前は坂だけが効き、標高を持つ。後ろは難易度も標高も無い。
const CLIMB = makeRouteSegment({
  distance_km: 1,
  difficulty: 40,
  axis_contributions: { axis_a: 40 },
  start_elevation_m: 12,
  end_elevation_m: 31.6,
  start_latitude: 35,
  start_longitude: 139,
  end_latitude: 35,
  end_longitude: 139.01,
});
const UNKNOWN = makeRouteSegment({
  distance_km: 1,
  difficulty: null,
  start_latitude: 35,
  start_longitude: 139.01,
  end_latitude: 35,
  end_longitude: 139.02,
});

type Props = React.ComponentProps<typeof RouteProfile>;

function renderProfile(props: Partial<Props> = {}) {
  const toggle = vi.fn();
  const view = render(
    <RouteProfile
      segments={[CLIMB, UNKNOWN]}
      overallDifficulty={20}
      axes={CATALOG.axes}
      axisColors={CATALOG.axisColors}
      scaleKm={2}
      selected={null}
      layers={{ ids: ["elevation"], toggle }}
      {...props}
    />,
  );
  return { ...view, toggle };
}

async function openLayers() {
  await userEvent.click(screen.getByRole("tab", { name: FACT_DISPLAY_NAME }));
}

describe("RouteProfile", () => {
  it("はじめは「評価で塗る」で難易度を出し、(i) で塗った軸の色と名前・値の無い区間・グラフの意味を開く", async () => {
    renderProfile();
    expect(screen.getByRole("tab", { name: EVALUATION_PAINT_NAME })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("img", { name: "道のりに沿った難易度" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "難易度のグラフの見方を表示" }));
    const note = screen.getByRole("dialog");
    expect(within(note).getByText("坂").previousElementSibling).toHaveStyle({
      backgroundColor: CATALOG.axisColors.axis_a,
    });
    expect(within(note).queryByText("路面")).toBeNull();
    expect(within(note).getByText("値の無い区間")).toBeInTheDocument();
    expect(note).toHaveTextContent(
      "高さは区間の難易度、塗った面積はルートの負荷にほぼ一致し、横の右端は一覧の中で最も長い候補の距離",
    );
  });

  it("「表示」のタブは選んだ情報の折れ線と最高・最低を出し、地点を選べばその地点の値を足し、チップで重ねる・外す", async () => {
    const { rerender, toggle } = renderProfile();
    await openLayers();
    const chart = screen.getByRole("img", { name: "道のりに沿った情報" });
    expect(chart.querySelectorAll("polyline")).toHaveLength(1);
    expect(screen.getByText("標高 最高 32m・最低 12m")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "難易度のグラフの見方を表示" })).toBeNull();

    // 地図で前の区間を選ぶ（なぞっていないので、地点は区間の始まり）。
    rerender(
      <RouteProfile
        segments={[CLIMB, UNKNOWN]}
        overallDifficulty={20}
        axes={CATALOG.axes}
        axisColors={CATALOG.axisColors}
        scaleKm={2}
        selected={{ segment: CLIMB, latitude: 35, longitude: 139 }}
        layers={{ ids: ["elevation"], toggle }}
      />,
    );
    expect(screen.getByText("標高 最高 32m・最低 12m・この地点 12m")).toBeInTheDocument();

    const chip = within(screen.getByRole("group", { name: "グラフに出す情報" })).getByRole("button", {
      name: "標高",
    });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(chip);
    expect(toggle).toHaveBeenCalledWith("elevation");
  });

  it.each<{ why: string; ids: string[]; segments: RouteSegmentDetail[]; text: string }>([
    { why: "出す情報を選んでいない", ids: [], segments: [CLIMB], text: "出す情報を選んでください。" },
    { why: "選んだ情報の値が無い", ids: ["elevation"], segments: [UNKNOWN], text: "標高の値がありません。" },
  ])("$why ときは、折れ線の代わりに文で知らせる", async ({ ids, segments, text }) => {
    renderProfile({ segments, layers: { ids, toggle: vi.fn() } });
    await openLayers();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "道のりに沿った情報" }).querySelector("polyline")).toBeNull();
  });
});
