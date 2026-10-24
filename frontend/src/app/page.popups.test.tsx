/**
 * `app/page.tsx`——トップページのうち、地図の小窓。
 *
 * 見ること: 区間・ピン・道・地図の点のどれを押しても小窓は1つだけで、最後に押した物の中身を出し、名前の無い点は押しても
 * 何も変えないこと。区間の中身から、その区間に
 * 属さない物（ピン・道・点）へ入れ替えると区間の選びを外し、開ける物の無い所を押すと閉じること。道の小窓を別の道へ押し替えると、
 * 前の道で押した評価を新しい道へ持ち越さないこと。見るだけの間の区間の小窓が、上の帯と難易度の塊の形で出ること。
 *
 * ここで見ないもの: 区間の近くの施設の小窓（区間へ戻る）は`app/page.map.test.tsx`の「区間の近くの施設」が、地図を押したときの
 * 意味をどのパネルが決めるかは同じファイルの「地図で扱えること」が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POINT_TILE_SOURCES } from "@/features/map/scene/groups/points";
import { sceneLayerId } from "@/features/map/scene/sceneBuilders";
import { onBackend } from "@/testing/backendServer";
import {
  ELSEWHERE,
  FIRST,
  HERE,
  LOOP_CONDITIONS,
  candidateTabs,
  clickMap,
  clickSegment,
  generate,
  marksAt,
  renderHome,
  route,
  selectedPointMarks,
  serveHome,
  showRoadSurface,
} from "@/testing/homePage";
import { mapOnScreen, type PointedFeature } from "@/testing/maplibre";
import { inspectorResult } from "@/testing/roadInspector";
import { makeRouteSegment } from "@/testing/routeFixtures";
import { settle } from "@/testing/settle";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

const ROAD: PointedFeature = { layer: "road-tiles-surface", properties: { osm_way_id: 1, feature_key: "1" } };

const CAFE = { latitude: 35.705, longitude: 139.705 };

describe("地図の小窓", () => {
  it("区間・ピン・道・点のどれを押しても小窓は1つだけで最後に押した物の中身を出し、区間の中身をほかの物へ入れ替えると区間の選びを外し、名前の無い点は何も変えず、何も無い所を押すと閉じる", async () => {
    const shop: PointedFeature = {
      layer: sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "supply_poi"),
      properties: { name: "角の店", kind: "convenience" },
      geometry: { type: "Point", coordinates: [ELSEWHERE.longitude, ELSEWHERE.latitude] },
    };
    const cafe: PointedFeature = {
      layer: sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "supply_poi"),
      properties: { name: "峠の茶屋", kind: "cafe" },
      geometry: { type: "Point", coordinates: [CAFE.longitude, CAFE.latitude] },
    };
    const toilet: PointedFeature = {
      layer: sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "supply_poi"),
      properties: { kind: "toilets" },
      geometry: { type: "Point", coordinates: [ELSEWHERE.longitude, ELSEWHERE.latitude] },
    };
    const { user } = renderHome();
    await showRoadSurface(user);
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("checkbox", { name: "補給・休憩ポイント" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "経由地を足す" }));
    clickMap(CAFE, [cafe]);
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");
    const [waypointPin] = marksAt(CAFE);

    clickSegment(drawnSegment, HERE);
    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toBeInTheDocument();

    await user.click(waypointPin.element);
    expect(screen.getByText("経由地 1: 峠の茶屋")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "区間の小窓の上の帯" })).toBeNull();
    expect(selectedPointMarks()).toEqual([]);

    clickSegment(drawnSegment, HERE);
    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toBeInTheDocument();
    expect(screen.queryByText("経由地 1: 峠の茶屋")).toBeNull();

    clickMap(ELSEWHERE, [ROAD]);
    expect(await screen.findByRole("button", { name: "この道の評価を見る" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "区間の小窓の上の帯" })).toBeNull();
    expect(selectedPointMarks()).toEqual([]);

    clickMap(ELSEWHERE, [shop]);
    expect(screen.getByText(/角の店/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "この道の評価を見る" })).toBeNull();

    // 名前の無い点は押しても何も開かず、開いている小窓もそのまま残す。
    clickMap(ELSEWHERE, [toilet]);
    expect(screen.getByText(/角の店/)).toBeInTheDocument();

    clickMap(ELSEWHERE, []);
    expect(screen.queryByText(/角の店/)).toBeNull();
  });

  it("見るだけの間に押した区間の小窓は、上の帯に何km地点と到達予想、その下に難易度の塊と風のチップを出す", async () => {
    const segment = makeRouteSegment({
      cumulative_distance_km: 1,
      estimated_arrival_time: "2026-10-05T00:30:00Z",
      difficulty: 42,
      wind: { speed_ms: 3.26, direction_deg: 180, forecast_at: "2026-10-05T09:00" },
    });
    const { user } = renderHome();
    jobs.respond([route("one", { segments: [segment] })], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));

    clickSegment(mapOnScreen().sourceFeatures("route-segments")[0], HERE);

    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toHaveTextContent(
      "ルートの何km地点 1.0km到達予想 09:30着",
    );
    const block = within(screen.getByRole("region", { name: "難易度" }));
    expect(screen.getByRole("region", { name: "難易度" })).toHaveTextContent(/^難易度42\.0\/100/);
    expect(
      block.getByRole("button", { name: /^区間の風（最寄りの格子点の値 .* 3\.3m\/s）の説明を表示$/ }),
    ).toBeInTheDocument();
  });

  it("評価を開いた道から別の道へ押し替えると、その道の評価は押すまで取りに行かない", async () => {
    const asked: unknown[] = [];
    onBackend("POST", "/api/region/axis-inspector", ({ body }) => {
      asked.push(body);
      return Response.json(inspectorResult());
    });
    const { user } = renderHome();
    await showRoadSurface(user);
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    clickMap(HERE, [ROAD]);
    await user.click(screen.getByRole("button", { name: "この道の評価を見る" }));
    expect(await screen.findByRole("region", { name: "道全体" })).toBeInTheDocument();

    clickMap(ELSEWHERE, [{ layer: "road-tiles-surface", properties: { osm_way_id: 2, feature_key: "2" } }]);
    expect(await screen.findByRole("button", { name: "この道の評価を見る" })).toBeInTheDocument();
    await settle();
    expect(asked).toEqual([expect.objectContaining({ osm_way_id: 1 })]);
  });
});
