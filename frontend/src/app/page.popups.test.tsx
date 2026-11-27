/**
 * `app/page.tsx`——トップページのうち、地図の小窓。
 *
 * 見ること: 「ルート結果」を開いていても、区間・道・地図の点のどれを押しても小窓は1つだけで、最後に押した物の中身を出すこと。
 * 点・区間はタップで開き、道はタップでは開かず、長押し（ここでは同じに受けるマウスの右ボタン）で、点の上でも、道の層を出していなくても押した所に近い
 * 道（backend の答え）を開き、道のタイルを読まずにその道の線を強調すること。
 * 名前の無い点も押すと種類の名前で並べ、重なった点と、束ねた代表点の中の点（名前の無い残りは数）は全部並べること。区間の中身から点を開くと区間へ戻れ、道へ
 * 入れ替えると区間の選びを外し、開ける物の無い所を押すと閉じること。押せる物のタップは待たずに開き、
 * 何も無い所を続けて2回押しても閉じないこと。
 *
 * ここで見ないもの: 区間の小窓の中身は`app/page.segmentPopup.test.tsx`が、ルートの近くの点の小窓（区間へ戻る）は`app/page.routePoints.test.tsx`が、地図を押したときの
 * 意味をどのパネルが決めるかは`app/page.map.test.tsx`が見る。触れた操作がタップか長押しか地図を動かす操作か（指の長押し・
 * ずらす・2本の指・ダブルタップ・流れている地図を止める）は`features/map/MapView/mapGestures.test.ts`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { act, screen, waitFor, within } from "@testing-library/react";
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
  doubleClickMap,
  generate,
  rightClickMap,
  renderHome,
  selectedSectionOnMap,
  serveHome,
  serveRoadsAt,
} from "@/testing/homePage";
import { mapOnScreen, type PointedFeature } from "@/testing/maplibre";
import { inspectorResult } from "@/testing/roadInspector";
import { settle } from "@/testing/settle";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

describe("地図の小窓", () => {
  const supplyPoint = (properties: Record<string, unknown>): PointedFeature => ({
    layer: sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "supply_poi"),
    properties,
    geometry: { type: "Point", coordinates: [ELSEWHERE.longitude, ELSEWHERE.latitude] },
  });
  const shop = supplyPoint({ name: "角の店", kind: "convenience" });
  const cafe = supplyPoint({ name: "峠の茶屋", kind: "cafe" });
  const toilet = supplyPoint({ kind: "toilets" });
  const header = (name: string) => screen.queryByRole("group", { name });
  const pointPopupLinks = () =>
    within(header("点の小窓の上の帯")!.parentElement!)
      .getAllByRole("link")
      .map((link) => link.textContent);

  /** 補給の点を地図に出し、「ルート結果」を開いたまま、ルートの区間の小窓を開く。 */
  async function openSegmentPopup() {
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("checkbox", { name: "補給・休憩" }));
    await user.keyboard("{Escape}");
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");
    clickSegment(drawnSegment, HERE);
    expect(header("区間の小窓の上の帯")).toBeInTheDocument();
    return user;
  }

  it("「ルート結果」を開いたままでも点を押すと点の小窓を出し、区間の中身から開くと区間へ戻れ、名前の無い点も種類の名前で並べ、重なった点と束ねた代表点の中身（名前の無い残りは数）を全部並べ、何も無い所を押すと閉じる", async () => {
    const user = await openSegmentPopup();

    // 区間の中身から点を開くと、区間の選びを残し、「‹ 区間」で区間の中身へ戻れる。押せる物のタップは、時計を進めずに開く（何も無い所の
    // タップだけを、ダブルタップの1回目でないと確かめるまで待つ）。何も無い所を続けて2回押しても（地図の拡大）、小窓は閉じない。
    act(() => mapOnScreen().click(ELSEWHERE, [shop]));
    expect(await screen.findByRole("link", { name: "角の店" })).toBeInTheDocument();
    doubleClickMap(HERE);
    expect(screen.getByRole("link", { name: "角の店" })).toBeInTheDocument();
    expect(selectedSectionOnMap()).toHaveLength(1);
    await user.click(within(header("点の小窓の上の帯")!).getByRole("button", { name: "‹ 区間" }));
    expect(header("区間の小窓の上の帯")).toBeInTheDocument();

    // 重なった点は全部並べ、名前の無い点は種類の名前で並べる（名前の無い点は外の地図のリンクを持たない）。
    clickMap(ELSEWHERE, [toilet, shop, cafe]);
    await waitFor(() => expect(pointPopupLinks()).toEqual(["角の店", "峠の茶屋"]));
    expect(within(header("点の小窓の上の帯")!.parentElement!).getByText("トイレ")).toBeInTheDocument();
    // 束ねた代表点は、中の名前のある店を1行ずつ、名前の無い残りを数を添えた1行で並べる。
    clickMap(ELSEWHERE, [
      supplyPoint({
        name: "角の店",
        kind: "convenience",
        [mapDisplay.point.countProperty]: 4,
        [mapDisplay.point.membersProperty]: JSON.stringify([
          ["角の店", ELSEWHERE.longitude, ELSEWHERE.latitude],
          ["駅前の店", ELSEWHERE.longitude + 0.0001, ELSEWHERE.latitude],
        ]),
      }),
    ]);
    await waitFor(() => expect(pointPopupLinks()).toEqual(["角の店", "駅前の店"]));
    expect(within(header("点の小窓の上の帯")!.parentElement!).getByText("2か所")).toBeInTheDocument();

    clickMap(ELSEWHERE);
    await settle();
    expect(header("点の小窓の上の帯")).toBeNull();
  });

  it("道は長押しで、点の上でも押した所に近い道（backend の答え）を開いて区間の選びを外し、道の層を出さずにその道の線を強調し、タップでは開かず、近くに道の無い所では開かない", async () => {
    serveRoadsAt([{ at: ELSEWHERE, properties: { osm_way_id: 1, feature_key: "1" } }]);
    // 道の小窓は開いたら負担を取りに行く。
    onBackend("POST", "/api/region/road-inspector", () => Response.json(inspectorResult()));
    await openSegmentPopup();

    rightClickMap(ELSEWHERE, [toilet]);
    expect(await screen.findByRole("group", { name: "道の小窓の上の帯" })).toBeInTheDocument();
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
    expect(selectedSectionOnMap()).toEqual([]);

    // 道はタップでは開かない（近くに道があっても、開ける物の無い所をタップすると閉じる）。
    clickMap(ELSEWHERE);
    await settle();
    expect(header("道の小窓の上の帯")).toBeNull();

    // 近くに道の無い所を長押ししても開かない。
    rightClickMap(HERE);
    await settle();
    expect(header("道の小窓の上の帯")).toBeNull();
    expect(mapOnScreen().sourceFeatures("road-inspected")).toEqual([]);
  });
});
