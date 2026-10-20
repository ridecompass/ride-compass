/**
 * `features/route/DifficultyProfile/DifficultyProfile.tsx`——候補の中身の先頭に出す、道のりに沿った難易度のグラフ。
 *
 * 見るもの: 長さのある区間が無ければ何も描かないこと、横軸の右端（候補の距離と渡された物差しの長い方）と目盛り、
 * 軸の色と色の無い軸の色、値の無い区間の灰色の塗り（総合難易度の高さ）、走行中の現在地の印（その距離の柱の上端）と、
 * 始点からそこまでの色を抜いた薄め（候補の終わりより先は終わりに寄せる）。
 *
 * ここで見ないもの: 区間の柱と積み上げの長方形の組み方（`axisOrder`の順に下から積むこと・寄与の無い軸を積まないこと・
 * 総合難易度が無ければ値の無い区間を塗らないことを含む） → `features/route/DifficultyProfile/profileGeometry.ts`。
 * 選ばれた区間の帯・スライダーとしての値・キーボードと指で選ぶ操作・見るだけの図 → `ProfileChart.test.tsx`。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { makeRouteSegment } from "@/testing/routeFixtures";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import DifficultyProfile from "./DifficultyProfile";

// 1kmずつの2区間。後ろは値の無い区間。
const FIRST = makeRouteSegment({
  distance_km: 1,
  difficulty: 60,
  axis_contributions: { axis_a: 40, axis_b: 20 },
  start_latitude: 35,
  start_longitude: 139,
  end_latitude: 35,
  end_longitude: 139.01,
});
const MISSING = makeRouteSegment({
  distance_km: 1,
  difficulty: null,
  start_latitude: 35,
  start_longitude: 139.01,
  end_latitude: 35,
  end_longitude: 139.02,
});
const COLORS = { axis_a: "rgb(10, 20, 30)", axis_b: "rgb(40, 50, 60)" };

type Props = React.ComponentProps<typeof DifficultyProfile>;

function profileProps(props: Partial<Props> = {}): Props {
  return {
    segments: [FIRST, MISSING],
    overallDifficulty: 30,
    axisOrder: ["axis_a", "axis_b"],
    axisColors: COLORS,
    scaleKm: 2,
    selected: null,
    onSelect: vi.fn(),
    waypointKms: [],
    ...props,
  };
}

function renderProfile(props: Partial<Props> = {}) {
  return render(<DifficultyProfile {...profileProps(props)} />);
}

/** 塗りの`path`を、塗りの色ごとに`d`で。 */
function paths(container: HTMLElement): { fill: string | null; d: string | null; opacity: string | null }[] {
  return Array.from(container.querySelectorAll("path")).map((path) => ({
    fill: path.getAttribute("fill"),
    d: path.getAttribute("d"),
    opacity: path.getAttribute("opacity"),
  }));
}

describe("DifficultyProfile", () => {
  it("長さのある区間が無ければ何も描かない", () => {
    expect(renderProfile({ segments: [] }).container).toBeEmptyDOMElement();
  });

  it("横軸の右端は、候補の距離と渡された物差しの長い方で、目盛りにその距離を出す", () => {
    const { container, unmount } = renderProfile({ scaleKm: 4 });
    expect(screen.getByText("4.0km")).toBeInTheDocument();
    // 1kmの区間が、横幅1000の4分の1を占める。
    expect(paths(container)[1].d).toBe("M0 60H250V100H0Z");
    unmount();

    renderProfile({ scaleKm: 1 });
    expect(screen.getByText("2.0km")).toBeInTheDocument();
  });

  it("色の無い軸は、値の無い区間と同じ色で塗る", () => {
    const { container } = renderProfile({ segments: [FIRST], axisColors: { axis_a: COLORS.axis_a } });
    expect(paths(container).map((path) => path.fill)).toEqual([COLORS.axis_a, palette.semantic.no_data]);
  });

  it("値の無い区間は総合難易度の高さで灰色に塗る", () => {
    const { container } = renderProfile({ overallDifficulty: 30 });
    expect(paths(container).find((path) => path.opacity === "0.6")).toEqual({
      fill: palette.semantic.no_data,
      d: "M500 70H1000V100H500Z",
      opacity: "0.6",
    });
  });

  it("現在地の距離に印を、その距離の柱の上端に置き、始点からそこまでは色を抜いて薄め、残りは元の色で描く。候補の終わりより先は終わりに寄せ、無ければ描かない", () => {
    const { container, rerender } = renderProfile({ scaleKm: 4, progressKm: 0.5 });
    const progress = () => {
      const travelled = container.querySelector('[data-progress="travelled"]');
      const ahead = container.querySelector('[data-progress="ahead"]');
      const clipWidth = (group: Element | null) => {
        const id = group?.getAttribute("clip-path")?.match(/#([^)]+)/)?.[1];
        return id === undefined ? null : container.querySelector(`[id="${id}"] rect`)?.getAttribute("width");
      };
      const filterId = travelled?.getAttribute("filter")?.match(/#([^)]+)/)?.[1];
      const mark = screen.queryByRole("img", { name: "現在地" });
      return {
        travelledWidth: clipWidth(travelled),
        travelledOpacity: travelled?.getAttribute("opacity") ?? null,
        travelledSaturate:
          filterId === undefined
            ? null
            : (container.querySelector(`[id="${filterId}"] feColorMatrix`)?.getAttribute("values") ?? null),
        travelledPaths: travelled?.querySelectorAll("path").length ?? 0,
        aheadPaths: ahead?.querySelectorAll("path").length ?? 0,
        aheadFilter: ahead?.getAttribute("filter") ?? null,
        mark: mark === null ? null : { left: mark.style.left, top: mark.style.top },
      };
    };
    const drawnPaths = 3;
    expect(progress()).toEqual({
      travelledWidth: "125",
      travelledOpacity: String(mapDisplay.route.opacities.travelled),
      travelledSaturate: "0",
      travelledPaths: drawnPaths,
      aheadPaths: drawnPaths,
      aheadFilter: null,
      // 0.5kmの柱は2軸を積んだ難易度60まで、値の無い区間の柱は総合難易度30まで。
      mark: { left: "12.5%", top: "40%" },
    });

    rerender(<DifficultyProfile {...profileProps({ scaleKm: 4, progressKm: 3 })} />);
    expect(progress()).toMatchObject({ travelledWidth: "500", mark: { left: "50%", top: "70%" } });

    rerender(<DifficultyProfile {...profileProps({ scaleKm: 4, progressKm: null })} />);
    expect(progress()).toMatchObject({ travelledWidth: null, aheadPaths: 0, mark: null });
    expect(container.querySelectorAll("path")).toHaveLength(drawnPaths);
  });
});
