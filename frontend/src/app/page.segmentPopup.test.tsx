/**
 * `app/page.tsx`——トップページのうち、地図で押した区間の小窓の中身。
 *
 * 見ること: 区間の小窓が上の帯に到達予想を、その下に負担の内訳を出し、寄せるアイコンで区間へ寄せること。ルートの脇の線のある区間では、
 * 避け方の倍率を決めた道ごとに脇の線の理由を出すこと。
 *
 * ここで見ないもの: 小窓がいつも1つで最後に押した物の中身を出すことと Street View のリンクは`app/page.popups.test.tsx`が、
 * 区間を押したときにどのパネルが小窓を出すかは`app/page.map.test.tsx`が、「区間を地図で見る」で寄せることは`app/page.sectionOnMap.test.tsx`が、
 * 小窓の×の大きさと区間に重ならない置き方は実寸が要るので`e2e/segment-popup.spec.ts`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { serveClientConfig, serveCostAxisCatalog } from "@/testing/backendServer";
import { AVOIDANCE_LEVELS, avoidanceRow, clientConfigResponse, roadClassCatalog } from "@/testing/clientConfig";
import {
  HERE,
  LOOP_CONDITIONS,
  candidateTabs,
  clickSegment,
  generate,
  renderHome,
  route,
  serveHome,
} from "@/testing/homePage";
import { mapOnScreen } from "@/testing/maplibre";
import { makeRouteSegment } from "@/testing/routeFixtures";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

describe("区間の小窓", () => {
  it("区間の小窓は、上の帯に到達予想、その下に分へ丸めて1分以上の軸の負担だけを出し、押しただけでは地図は動かず、寄せるアイコンで区間へ寄せる", async () => {
    serveCostAxisCatalog();
    const segment = makeRouteSegment({
      estimated_arrival_time: "2026-10-05T00:30:00Z",
      penalty: {
        axis_seconds: { ascent: 120, vibration: 29 },
        preferred_seconds: 0,
        avoided_seconds: 0,
        turn_penalty_seconds: 0,
        total_seconds: 149,
      },
    });
    const { user } = renderHome();
    // 2つ目の区間は、どの軸も分へ丸めると1分に満たない。
    const slight = makeRouteSegment({
      penalty: {
        axis_seconds: { ascent: 29, vibration: 29 },
        preferred_seconds: 0,
        avoided_seconds: 0,
        turn_penalty_seconds: 0,
        total_seconds: 58,
      },
    });
    jobs.respond([route("one", { segments: [segment, slight] })], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));

    const fitsBefore = mapOnScreen().fits().length;
    clickSegment(mapOnScreen().sourceFeatures("route-segments")[1], HERE);
    expect(await screen.findByRole("group", { name: "区間の小窓の上の帯" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "負担の内訳" })).toBeNull();

    clickSegment(mapOnScreen().sourceFeatures("route-segments")[0], HERE);

    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toHaveTextContent("到達予想 09:30着");
    // 軸は絵で出し、名前は読み上げに残す。分へ丸めて1分に満たない軸と合計は出さない。
    expect(screen.getByRole("group", { name: "負担の内訳" })).toHaveTextContent(/^登坂\+2分$/);

    expect(mapOnScreen().fits()).toHaveLength(fitsBefore);
    await user.click(screen.getByRole("button", { name: "地図をここへ寄せる" }));
    await waitFor(() => expect(mapOnScreen().fits()).toHaveLength(fitsBefore + 1));
  });

  it("ルートの脇の線のある区間の小窓は、避け方の倍率を決めた道ごとに、線と同じ印で道の名前と分に丸めて1分以上の増えた・減った分、まとまり・長さ・段を出す", async () => {
    serveClientConfig(
      clientConfigResponse({
        road_classes: roadClassCatalog({
          avoidance: {
            levels: AVOIDANCE_LEVELS,
            sections: [{ key: "highway", label: "道路の種類" }],
            rows: [
              avoidanceRow("highway.secondary", "highway", { label: "一般県道" }),
              avoidanceRow("highway.primary", "highway", { label: "主要地方道" }),
              avoidanceRow("highway.cycleway", "highway", { label: "自転車の道" }),
            ],
          },
        }),
      }),
    );
    const segment = makeRouteSegment({
      avoidance_stretches: [
        { row_key: "highway.primary", level: "slight_avoid", distance_km: 0.3, seconds: 60 },
        { row_key: "highway.cycleway", level: "slight_prefer", distance_km: 0.1, seconds: -29 },
      ],
      penalty: {
        axis_seconds: {},
        preferred_seconds: -29,
        avoided_seconds: 60,
        turn_penalty_seconds: 0,
        total_seconds: 31,
      },
    });
    const { user } = renderHome();
    jobs.respond([route("one", { segments: [segment] })], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));

    clickSegment(mapOnScreen().sourceFeatures("route-segments")[0], HERE);

    // 行・まとまり・段の名前は道路タブと同じ画面の設定から引き、並びは応答のまま。
    expect(await screen.findByRole("list", { name: "ルートの脇の線の理由" })).toHaveTextContent(
      /^主要地方道\+1分道路の種類・300m・×1\.4自転車の道好んだ道道路の種類・100m・×0\.7$/,
    );
  });
});
