/**
 * `app/page.tsx`——トップページのうち、地図の小窓。
 *
 * 見ること: 「ルート結果」を開いていても、区間・道・地図の点のどれを押しても小窓は1つだけで、最後に押した物の中身を出すこと。
 * 点・区間はタップで開き、道はタップでは開かず、長押しで、道の層を出していなくても押した所に近い道（backend の答え）を開き、道の
 * タイルを読まずにその道の線を強調すること。地図を動かす操作（ずらす・2本の指・ダブルタップ・流れている地図を止める）は、小窓を開かないこと。
 * 名前の無い点は押せる物に数えず下の物を開き、重なった名前のある点と、束ねた代表点の中の点は全部並べること。区間の中身から点を開くと区間へ戻れ、道へ
 * 入れ替えると区間の選びを外し、開ける物の無い所を押すと閉じること。道の小窓を別の道へ押し替えると、前の道で押した評価を
 * 新しい道へ持ち越さないこと。区間の小窓が上の帯と難易度の塊の形で出て、寄せるアイコンで寄せること。
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
import { mapDisplay } from "@/types/generated/mapDisplay";
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
  longPressMap,
  renderHome,
  route,
  selectedPointMarks,
  serveHome,
  serveRoadsAt,
} from "@/testing/homePage";
import { mapOnScreen, type PointedFeature } from "@/testing/maplibre";
import { TAP_CONFIRM_MS } from "@/features/map/MapView/mapTaps";
import { act } from "@testing-library/react";
import { inspectorResult } from "@/testing/roadInspector";
import { makeRouteSegment } from "@/testing/routeFixtures";
import { settle } from "@/testing/settle";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

describe("地図の小窓", () => {
  it("「ルート結果」を開いたままでも、区間・点・道のどれを押しても小窓は1つだけで最後に押した物の中身を出す。道は長押しで開き、名前の無い点は飛ばして下の物を開き、重なった名前のある点と束ねた代表点の中の点は全部並べ、区間の中身から点を開くと区間へ戻れる", async () => {
    const shop: PointedFeature = {
      layer: sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "supply_poi"),
      properties: { name: "角の店", kind: "convenience" },
      geometry: { type: "Point", coordinates: [ELSEWHERE.longitude, ELSEWHERE.latitude] },
    };
    const cafe: PointedFeature = {
      layer: sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "supply_poi"),
      properties: { name: "峠の茶屋", kind: "cafe" },
      geometry: { type: "Point", coordinates: [ELSEWHERE.longitude, ELSEWHERE.latitude] },
    };
    const bundled: PointedFeature = {
      layer: sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "supply_poi"),
      properties: {
        name: "角の店",
        kind: "convenience",
        [mapDisplay.point.countProperty]: 2,
        [mapDisplay.point.membersProperty]: JSON.stringify([
          ["角の店", ELSEWHERE.longitude, ELSEWHERE.latitude],
          ["駅前の店", ELSEWHERE.longitude + 0.0001, ELSEWHERE.latitude],
        ]),
      },
      geometry: { type: "Point", coordinates: [ELSEWHERE.longitude, ELSEWHERE.latitude] },
    };
    const toilet: PointedFeature = {
      layer: sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "supply_poi"),
      properties: { kind: "toilets" },
      geometry: { type: "Point", coordinates: [ELSEWHERE.longitude, ELSEWHERE.latitude] },
    };
    serveRoadsAt([{ at: ELSEWHERE, properties: { osm_way_id: 1, feature_key: "1" } }]);
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("checkbox", { name: "補給・休憩ポイント" }));
    await user.keyboard("{Escape}");
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");
    const header = (name: string) => screen.queryByRole("group", { name });

    await clickSegment(drawnSegment, HERE);
    expect(header("区間の小窓の上の帯")).toBeInTheDocument();

    // 区間の中身から点を開くと、区間の選びを残し、「‹ 区間」で区間の中身へ戻れる。
    await clickMap(ELSEWHERE, [shop]);
    expect(screen.getByRole("link", { name: "角の店" })).toBeInTheDocument();
    expect(selectedPointMarks()).toHaveLength(1);
    await user.click(within(header("点の小窓の上の帯")!).getByRole("button", { name: "‹ 区間" }));
    expect(header("区間の小窓の上の帯")).toBeInTheDocument();

    longPressMap(ELSEWHERE);
    expect(await screen.findByRole("button", { name: "この道の評価を見る" })).toBeInTheDocument();
    expect(header("区間の小窓の上の帯")).toBeNull();
    expect(
      mapOnScreen()
        .sourceFeatures("road-inspected")
        .map((feature) => feature.geometry),
    ).toEqual([
      {
        type: "LineString",
        coordinates: [
          [ELSEWHERE.longitude, ELSEWHERE.latitude],
          [ELSEWHERE.longitude + 0.001, ELSEWHERE.latitude],
        ],
      },
    ]);
    // 道のタイルは、道の層を出していないので読まない（MapLibre は、描くレイヤーの無いソースのタイルを読まない）。
    expect(
      mapOnScreen()
        .visibleLayerIds()
        .filter((id) => id.startsWith("road-tiles")),
    ).toEqual([]);
    expect(selectedPointMarks()).toEqual([]);

    // 重なった名前のある点は全部並べ、名前の無い点は飛ばす。名前の無い点だけの所は、下の道を開く。
    await clickMap(ELSEWHERE, [toilet, shop, cafe]);
    expect(
      within(header("点の小窓の上の帯")!.parentElement!)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["角の店", "峠の茶屋"]);
    // 束ねた代表点は、中の店を1行ずつ並べる。
    await clickMap(ELSEWHERE, [bundled]);
    expect(
      within(header("点の小窓の上の帯")!.parentElement!)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["角の店", "駅前の店"]);
    longPressMap(ELSEWHERE, [toilet]);
    expect(await screen.findByRole("button", { name: "この道の評価を見る" })).toBeInTheDocument();
    // 道はタップでは開かない（近くに道があっても、開ける物の無い所をタップすると閉じる）。
    await clickMap(ELSEWHERE, [toilet]);
    await settle();
    expect(header("道の小窓の上の帯")).toBeNull();

    // 近くに道の無い所を長押ししても開かない。
    longPressMap(HERE);
    await settle();
    expect(header("道の小窓の上の帯")).toBeNull();
    expect(mapOnScreen().sourceFeatures("road-inspected")).toEqual([]);
  });

  it("区間の小窓は、上の帯に何km地点と到達予想、その下に難易度の塊を出し、押しただけでは地図は動かず、寄せるアイコンで区間へ寄せる", async () => {
    const segment = makeRouteSegment({
      cumulative_distance_km: 1,
      estimated_arrival_time: "2026-10-05T00:30:00Z",
      difficulty: 42,
    });
    const { user } = renderHome();
    jobs.respond([route("one", { segments: [segment] })], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));

    const fitsBefore = mapOnScreen().fits().length;
    await clickSegment(mapOnScreen().sourceFeatures("route-segments")[0], HERE);

    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toHaveTextContent(
      "ルートの何km地点 1.0km到達予想 09:30着",
    );
    expect(screen.getByRole("region", { name: "難易度" })).toHaveTextContent(/^難易度42\.0\/100/);

    expect(mapOnScreen().fits()).toHaveLength(fitsBefore);
    await user.click(screen.getByRole("button", { name: "地図をここへ寄せる" }));
    await waitFor(() => expect(mapOnScreen().fits()).toHaveLength(fitsBefore + 1));
  });

  it("評価を開いた道から別の道へ押し替えると、その道の評価は押すまで取りに行かない", async () => {
    const asked: unknown[] = [];
    onBackend("POST", "/api/region/axis-inspector", ({ body }) => {
      asked.push(body);
      return Response.json(inspectorResult());
    });
    serveRoadsAt([
      { at: HERE, properties: { osm_way_id: 1, feature_key: "1" } },
      { at: ELSEWHERE, properties: { osm_way_id: 2, feature_key: "2" } },
    ]);
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    longPressMap(HERE);
    await user.click(await screen.findByRole("button", { name: "この道の評価を見る" }));
    expect(await screen.findByRole("region", { name: "難易度" })).toBeInTheDocument();

    longPressMap(ELSEWHERE);
    expect(await screen.findByRole("button", { name: "この道の評価を見る" })).toBeInTheDocument();
    await settle();
    expect(asked).toEqual([expect.objectContaining({ osm_way_id: 1 })]);
  });
});

// 都市部ではどこを押しても点か道に重なるので、地図を動かすために触っただけで小窓が開くと、地図を動かすたびに小窓が出る。
describe("地図を動かす操作と小窓", () => {
  const SHOP: PointedFeature = {
    layer: sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "supply_poi"),
    properties: { name: "角の店", kind: "convenience" },
    geometry: { type: "Point", coordinates: [ELSEWHERE.longitude, ELSEWHERE.latitude] },
  };
  const touch = (type: string, x: number, fingers = 1) =>
    mapOnScreen().emit(type, {
      point: { x, y: 0 },
      originalEvent: { timeStamp: performance.now(), touches: Array.from({ length: fingers }, () => ({})) },
    });
  const tap = () => mapOnScreen().click(ELSEWHERE, [SHOP]);

  it.each<[string, boolean, () => void]>([
    ["指を置いて離しただけ", true, () => (touch("touchstart", 0), tap())],
    ["指を置いてずらした", false, () => (touch("touchstart", 0), touch("touchmove", 10), tap())],
    ["2本の指で触った", false, () => (touch("touchstart", 0), touch("touchstart", 0, 2), tap())],
    ["ダブルタップした", false, () => (touch("touchstart", 0), tap(), touch("touchstart", 0), tap())],
    [
      "流れている地図を指で止めた",
      false,
      () => (
        mapOnScreen().emit("movestart", { originalEvent: {} }),
        touch("touchstart", 0),
        mapOnScreen().emit("moveend"),
        tap()
      ),
    ],
  ])("%sときは、点の小窓を開くか: %s", async (_, opens, operate) => {
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("checkbox", { name: "補給・休憩ポイント" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));

    act(operate);
    await act(() => new Promise((resolve) => setTimeout(resolve, TAP_CONFIRM_MS)));

    expect(screen.queryByRole("group", { name: "点の小窓の上の帯" }) !== null).toBe(opens);
  });
});
