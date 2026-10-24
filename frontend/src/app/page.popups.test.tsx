/**
 * `app/page.tsx`——トップページのうち、地図の小窓。
 *
 * 見ること: 区間・ピン・道・地図の点のどれを押しても小窓は1つだけで、最後に押した物の中身を出すこと。区間の中身から、その区間に
 * 属さない物（ピン・道・点）へ入れ替えると区間の選びを外し、開ける物の無い所を押すと閉じること。道の小窓を別の道へ押し替えると、
 * 前の道で押した評価を新しい道へ持ち越さないこと。
 *
 * ここで見ないもの: 区間の近くの施設の小窓（区間へ戻る）は`app/page.map.test.tsx`の「区間の近くの施設」が、地図を押したときの
 * 意味をどのパネルが決めるかは同じファイルの「地図で扱えること」が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { screen, waitFor } from "@testing-library/react";
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
  selectedPointMarks,
  serveHome,
  showRoadSurface,
} from "@/testing/homePage";
import { mapOnScreen, type PointedFeature } from "@/testing/maplibre";
import { inspectorResult } from "@/testing/roadInspector";
import { settle } from "@/testing/settle";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

const ROAD: PointedFeature = { layer: "road-tiles-surface", properties: { osm_way_id: 1, feature_key: "1" } };

describe("地図の小窓", () => {
  it("区間・ピン・道・点のどれを押しても小窓は1つだけで最後に押した物の中身を出し、区間の中身をほかの物へ入れ替えると区間の選びを外し、何も無い所を押すと閉じる", async () => {
    const shop: PointedFeature = {
      layer: sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "supply_poi"),
      properties: { name: "角の店", kind: "convenience" },
      geometry: { type: "Point", coordinates: [ELSEWHERE.longitude, ELSEWHERE.latitude] },
    };
    const { user } = renderHome();
    await showRoadSurface(user);
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("checkbox", { name: "補給・休憩ポイント" }));
    await user.keyboard("{Escape}");
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");
    const [originPin] = marksAt(HERE);

    clickSegment(drawnSegment, HERE);
    expect(screen.getByText(/km地点/)).toBeInTheDocument();

    await user.click(originPin.element);
    expect(screen.getByText("出発地: 現在地")).toBeInTheDocument();
    expect(screen.queryByText(/km地点/)).toBeNull();
    expect(selectedPointMarks()).toEqual([]);

    clickSegment(drawnSegment, HERE);
    expect(screen.getByText(/km地点/)).toBeInTheDocument();
    expect(screen.queryByText("出発地: 現在地")).toBeNull();

    clickMap(ELSEWHERE, [ROAD]);
    expect(await screen.findByRole("button", { name: "この道の評価を見る" })).toBeInTheDocument();
    expect(screen.queryByText(/km地点/)).toBeNull();
    expect(selectedPointMarks()).toEqual([]);

    clickMap(ELSEWHERE, [shop]);
    expect(screen.getByText(/角の店/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "この道の評価を見る" })).toBeNull();

    clickMap(ELSEWHERE, []);
    expect(screen.queryByText(/角の店/)).toBeNull();
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
    expect(await screen.findByText(/この道全体で見た難易度/)).toBeInTheDocument();

    clickMap(ELSEWHERE, [{ layer: "road-tiles-surface", properties: { osm_way_id: 2, feature_key: "2" } }]);
    expect(await screen.findByRole("button", { name: "この道の評価を見る" })).toBeInTheDocument();
    await settle();
    expect(asked).toEqual([expect.objectContaining({ osm_way_id: 1 })]);
  });
});
