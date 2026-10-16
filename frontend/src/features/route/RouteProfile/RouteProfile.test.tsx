/**
 * `features/route/RouteProfile/RouteProfile.tsx`——道のりのグラフの「レイヤ」「レンズ」のタブ。
 *
 * 見るもの: 既定でレンズ（難易度のグラフ）を出すこと、レンズの (i) が塗った軸の色と名前・値の無い区間の色・意味の文を出すこと
 * （塗る区間の無い軸は出さない）、レイヤのタブのチップが選んだレイヤを重ね・外す知らせを上げること、標高の折れ線と最高・最低、
 * 選んだ地点の標高、重ねるレイヤが無いときと値が無いときの文。
 *
 * ここで見ないもの: 難易度の塗り・なぞって地点を選ぶ操作 → `DifficultyProfile.test.tsx`。折れ線の点と地点の値の計算 →
 * `profileLayers.test.ts`。選んだレイヤを覚えること → `useProfileLayers.test.ts`。
 */
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
  await userEvent.click(screen.getByRole("tab", { name: "レイヤ" }));
}

describe("RouteProfile", () => {
  it("はじめはレンズで難易度を出し、(i) で塗った軸の色と名前・値の無い区間・グラフの意味を開く", async () => {
    renderProfile();
    expect(screen.getByRole("tab", { name: "レンズ" })).toHaveAttribute("aria-selected", "true");
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

  it("レイヤのタブは選んだレイヤの折れ線と最高・最低を出し、地点を選べばその地点の値を足し、チップで重ねる・外す", async () => {
    const { rerender, toggle } = renderProfile();
    await openLayers();
    const chart = screen.getByRole("img", { name: "道のりに沿ったレイヤ" });
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

    const chip = within(screen.getByRole("group", { name: "グラフに重ねるレイヤ" })).getByRole("button", {
      name: "標高",
    });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(chip);
    expect(toggle).toHaveBeenCalledWith("elevation");
  });

  it.each<{ why: string; ids: string[]; segments: RouteSegmentDetail[]; text: string }>([
    { why: "重ねるレイヤを選んでいない", ids: [], segments: [CLIMB], text: "重ねるレイヤを選んでください。" },
    { why: "選んだレイヤの値が無い", ids: ["elevation"], segments: [UNKNOWN], text: "標高の値がありません。" },
  ])("$why ときは、折れ線の代わりに文で知らせる", async ({ ids, segments, text }) => {
    renderProfile({ segments, layers: { ids, toggle: vi.fn() } });
    await openLayers();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "道のりに沿ったレイヤ" }).querySelector("polyline")).toBeNull();
  });
});
