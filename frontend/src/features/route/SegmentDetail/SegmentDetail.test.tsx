/**
 * `features/route/SegmentDetail/SegmentDetail.tsx`——選んだ区間の小窓の中身（道のりのグラフの表示の断面）。
 *
 * 見るもの: 上の帯に何km地点と到達予想（読めなければ出さない）、グラフで選んでいる層だけのその地点の値（線の層は値と勾配、帯の層は
 * 区分のチップ。当たらない区分は出さない）、難易度の塊を出すこと。値は、選んだ地点を区間の道なりに当てた所のもの。
 *
 * 差し替えたもの: 無し（軸カタログは網の層で与える）。
 *
 * ここで見ないもの: 小窓を開く・閉じる・置く場所 → `app/page.popups.test.tsx`。難易度の塊の中身 → `components/MapPopup` の
 * テスト。地点の値・行の計算 → `features/route/RouteProfile/profileLayers.test.ts`。
 */
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { profileLayers } from "@/features/route/RouteProfile/profileLayers";
import { PAVED, ROAD_LAYERS, UNKNOWN, serveProfileCatalog, surfaceColor } from "@/testing/routeProfile";
import type { RouteSegmentDetail, SelectedRouteSegment } from "@/types/route";

import SegmentDetail from "./SegmentDetail";

beforeEach(serveProfileCatalog);

const ALL_LAYERS = profileLayers(ROAD_LAYERS);

function renderDetail(selection: SelectedRouteSegment, layerIds: readonly string[], segments = [PAVED, UNKNOWN]) {
  render(
    <SegmentDetail
      selection={selection}
      segments={segments}
      layers={ALL_LAYERS.filter((layer) => layerIds.includes(layer.id))}
    />,
  );
}

const header = () => screen.getByRole("group", { name: "区間の小窓の上の帯" });
const values = () => screen.queryByRole("group", { name: "グラフの層の値" });

describe("SegmentDetail", () => {
  it("グラフで選んでいる層の、選んだ地点の値と区分を出し、当たらない区分は出さない。難易度の塊を続ける", async () => {
    // 選んだ地点は区間の始まりから0.3km東。
    renderDetail({ segment: PAVED, latitude: 35, longitude: 139.003 }, [
      "elevation",
      ...ROAD_LAYERS.map((layer) => layer.id),
    ]);
    expect(header()).toHaveTextContent("ルートの何km地点 0.0km到達予想 09:42着");
    // 標高は12mから31.6mへ1kmで上る道の0.3kmの地点。
    expect(values()).toHaveTextContent("標高 18m勾配 +2.0%");
    // トンネルの「該当なし」と、値の無い区分の「データなし」はチップにしない。区分のチップは行の凡例の色の印を持つ。
    const chips = within(values()!).getAllByRole("listitem");
    expect(chips.map((chip) => chip.textContent)).toEqual(["路面の種類 舗装"]);
    expect(chips[0].querySelector("span[style]")).toHaveStyle({ backgroundColor: surfaceColor("paved") });
    expect(await screen.findByRole("region", { name: "難易度" })).toHaveTextContent(/^難易度40\.0\/100/);
  });

  it.each<[string, readonly string[], string | null]>([
    ["線の層だけ", ["elevation"], "標高 12m勾配 +2.0%"],
    ["何も選んでいない", [], null],
  ])("グラフで%sを選んでいるときは、その層だけを出す", (_, layerIds, shown) => {
    renderDetail({ segment: PAVED, latitude: 35, longitude: 139 }, layerIds);
    expect(values()?.textContent ?? null).toBe(shown);
  });

  it.each<[string, Partial<RouteSegmentDetail>]>([
    ["到達予想が無い", { estimated_arrival_time: null }],
    ["到達予想が時刻として読めない", { estimated_arrival_time: "not-a-time" }],
  ])("%s区間は、上の帯に到達予想を出さない", (_, overrides) => {
    const segment = { ...PAVED, ...overrides };
    renderDetail({ segment, latitude: 35, longitude: 139 }, [], [segment]);
    expect(header()).toHaveTextContent(/^ルートの何km地点 0\.0km$/);
  });
});
