/**
 * `features/route/RouteProfile/LayerProfile.tsx`・`features/route/RouteProfile/ProfileLayerPicker.tsx`——道のりのグラフの「表示」の図と、
 * そこに重ねる情報を選ぶ一覧。図は道のりのグラフ（`features/route/RouteProfile/RouteProfile.tsx`）を描いて「表示」のタブを開いて見る。
 *
 * 見るもの: 標高の折れ線と最高・最低、「グラフに出す情報」の一覧のチップが選んだ情報を重ね・外す知らせを上げること、
 * 走行中の現在地の印を最初の折れ線のその地点の高さに置くこと（値が無ければ中ほど）、出す情報が無いときと値が無いときの文、
 * 道の区分のレイヤの帯をレイヤごとに地図と同じ色で出し、その凡例を出すこと、走行中の図に標高の目盛りを出すこと。
 *
 * 差し替えたもの: 道の区分の層は軸カタログの応答としてテストが組む（本番の層は管理DBが持つ）。
 *
 * ここで見ないもの: タブ・難易度のグラフの見方・経由地の印 → `RouteProfile.test.tsx`。選んだ区間の層の値 → `profileLayers.test.ts`。折れ線の点・帯の切れ目と
 * 地点の値・行の計算 → `profileLayers.test.ts`。選んだレイヤを覚えること → `useProfileLayers.test.ts`。
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIMB,
  UNKNOWN,
  openLayers,
  profileElement,
  renderProfile,
  serveProfileCatalog,
  surfaceColor,
} from "@/testing/routeProfile";
import type { RouteSegmentDetail } from "@/types/route";

beforeEach(serveProfileCatalog);

describe("RouteProfile の「表示」の図", () => {
  it("「表示」のタブは選んだ情報の折れ線と最高・最低を出し、「グラフに出す情報」の一覧で重ねる・外す", async () => {
    const { toggle } = renderProfile();
    await openLayers();
    const chart = screen.getByRole("img", { name: "道のりに沿った情報" });
    expect(chart.querySelectorAll("polyline")).toHaveLength(1);
    expect(screen.getByText("標高 最高 32m・最低 12m")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "難易度のグラフの見方を表示" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "グラフに出す情報" }));
    const elevation = within(screen.getByRole("dialog")).getByRole("checkbox", { name: "標高" });
    expect(elevation).toBeChecked();
    await userEvent.click(elevation);
    expect(toggle).toHaveBeenCalledWith("elevation");
  });

  it("「表示」のタブの現在地の印は、最初の折れ線のその地点の値の高さに置き、その地点に値が無ければ図の中ほどに置く", async () => {
    const { rerender } = renderProfile({ scaleKm: 2, progressKm: 0.25 });
    await openLayers();
    const mark = () => screen.getByRole("img", { name: "現在地" });
    // 標高12〜31.6mの1/4の高さ（上下の余白8を除いた84の1/4だけ下端から上がる）。
    expect(mark().style).toMatchObject({ left: "12.5%", top: "71%" });

    rerender(profileElement({ progressKm: 1.5 }));
    expect(mark().style).toMatchObject({ left: "75%", top: "50%" });
  });

  it("道の区分のレイヤは、レイヤごとに地図と同じ色の帯を出し、帯に現れた区分の凡例を「グラフに出す情報」の一覧の行に出す", async () => {
    const paved = {
      ...CLIMB,
      road_classes: { surface: [{ distance_km: 1, value: "paved" }], tunnel: [{ distance_km: 1, value: "tunnel" }] },
    };
    const gravel = {
      ...UNKNOWN,
      road_classes: { surface: [{ distance_km: 1, value: "gravel" }], tunnel: [{ distance_km: 1, value: null }] },
    };
    renderProfile({ segments: [paved, gravel], layers: { ids: ["surface", "tunnel"], toggle: vi.fn() } });
    await openLayers();
    const chart = screen.getByRole("img", { name: "道のりに沿った情報" });
    // 道の層は軸カタログが届いてから出る。
    const surfaceBand = await waitFor(() => chart.querySelector('[data-layer="surface"]')!);
    expect([...surfaceBand.querySelectorAll("rect")].map((rect) => rect.getAttribute("fill"))).toEqual([
      surfaceColor("paved"),
      surfaceColor("gravel"),
    ]);
    expect(chart.querySelectorAll('[data-layer="tunnel"] rect')).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "グラフに出す情報" }));
    expect(
      within(screen.getByRole("list", { name: "路面の種類の凡例" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["舗装", "砂利・未舗装"]);
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

  it("走行中の「表示」の図は、最初の折れ線の最高と最低の高さに単位つきの標高の目盛りを出す（結果の図には出さない）", async () => {
    const { rerender } = renderProfile({ riding: true, progressKm: 0.25 });
    await openLayers();
    // 帯の無い図の上下の余白8の位置。
    expect(screen.getByText("標高 32m").style.top).toBe("8%");
    expect(screen.getByText("12m").style.top).toBe("92%");

    rerender(profileElement());
    expect(screen.queryByText("標高 32m")).toBeNull();
  });
});
