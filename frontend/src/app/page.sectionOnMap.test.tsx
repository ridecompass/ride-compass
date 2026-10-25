/**
 * `app/page.tsx`——トップページのうち、選んだ区間を地図で見ること。
 *
 * 見ること: 区間を選んでも（地図の線で押しても、グラフで選んでも）地図は動かず、区間の詳しくの「区間を地図で見る」を押したときだけ
 * その区間へ寄せること。区間が地図の見えている所の外にある間だけ、そのボタンが外にあることを知らせること。
 *
 * ここで見ないもの: 走行中に寄せるときに追うのを休むことは`app/page.rideControl.test.tsx`、区間の小窓と近くの施設は
 * `app/page.map.test.tsx`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 * 地図の見えている範囲は代役へテストが置く（`moveTo`）。
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  HERE,
  LOOP_CONDITIONS,
  candidateTabs,
  clickMap,
  clickSegment,
  generate,
  renderHome,
  route,
  serveHome,
} from "@/testing/homePage";
import { mapOnScreen } from "@/testing/maplibre";
import { routeThrough } from "@/testing/routeFixtures";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

// 東へ1kmずつ進む区間2つ。
const EASTWARD = route("eastward", {
  ...routeThrough({ a: [139.7, 35.7], b: [139.71, 35.7], c: [139.72, 35.7] }, ["a", "b", "c"], [1, 1]),
  distance_km: 2,
});

const showOnMap = () => screen.getByRole("button", { name: "区間を地図で見る" });

describe("選んだ区間を地図で見る", () => {
  it("区間を地図の線で押してもグラフで選んでも地図は動かず、「区間を地図で見る」を押したときだけその区間へ寄せる", async () => {
    const { user } = renderHome();
    jobs.respond([EASTWARD], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const fitsBefore = mapOnScreen().fits().length;

    const [, second] = mapOnScreen().sourceFeatures("route-segments");
    clickSegment(second, HERE);
    await user.click(showOnMap());
    expect(mapOnScreen().fits()).toHaveLength(fitsBefore + 1);
    expect(mapOnScreen().fits().at(-1)).toEqual({
      bounds: [
        [139.71, 35.7],
        [139.72, 35.7],
      ],
      maxZoom: 16,
    });

    // 何も無い所を押して選びを外し、グラフで選び直す。グラフで選んでも地図は動かず、地図にその区間の小窓が出る。
    clickMap(HERE);
    fireEvent.keyDown(screen.getByRole("slider", { name: /^道のりに沿った難易度/ }), { key: "Home" });
    expect(mapOnScreen().fits()).toHaveLength(fitsBefore + 1);
    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toHaveTextContent("0.0km");
    await user.click(showOnMap());
    expect(mapOnScreen().fits().at(-1)).toEqual({
      bounds: [
        [139.7, 35.7],
        [139.71, 35.7],
      ],
      maxZoom: 16,
    });
  });

  it("選んだ区間が地図の見えている所の外にある間だけ、「区間を地図で見る」が外にあることを知らせる", async () => {
    const { user } = renderHome();
    jobs.respond([EASTWARD], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    act(() => mapOnScreen().moveTo({ west: 139.69, south: 35.69, east: 139.73, north: 35.71 }, 14));

    const [, second] = mapOnScreen().sourceFeatures("route-segments");
    clickSegment(second, HERE);
    expect(showOnMap()).not.toHaveAccessibleDescription();

    act(() => mapOnScreen().moveTo({ west: 140, south: 36, east: 140.1, north: 36.1 }, 14));
    expect(showOnMap()).toHaveAccessibleDescription("区間は地図の外です");

    act(() => mapOnScreen().moveTo({ west: 139.715, south: 35.69, east: 139.73, north: 35.71 }, 14));
    expect(showOnMap()).not.toHaveAccessibleDescription();
  });
});
