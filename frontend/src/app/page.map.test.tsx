/**
 * `app/page.tsx`——トップページのうち、地図を押したときに起きること。
 *
 * 見ること: 地図を押したときの意味は効いているパネルで決まり（「ルート設定」の条件タブは選んでいる地点を置く、
 * 「ルート結果」は候補の線でそのルートを選び区間でその中身を出す、閉じている間は押した物の中身を小窓に出すだけ）、PC で
 * 2つの区分を開いていれば最後に触った区分が効いてその題に添えること、区間を選んでいる間は地図にその区間の範囲の縁取りが
 * 出ること、効いているパネルが移ると前のパネルで地図に出した選択を外すこと。地図は選んでいるルート1本へ収め（生成直後は先頭、
 * タブで選び直すとその1本）、地図の候補の線を押して選んだときは収め直さないこと。
 *
 * ここで見ないもの: 地図に置く地点（ピン・名前のある点・目的地・保存した地点）は`app/page.places.test.tsx`が、小窓がいつも1つで
 * 最後に押した物の中身を出すことと道の小窓は`app/page.popups.test.tsx`が、ルートの近くの点の描き方と点の小窓は
 * `app/page.routePoints.test.tsx`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POINT_TILE_SOURCES } from "@/features/map/scene/groups/points";
import { sceneLayerId } from "@/features/map/scene/sceneBuilders";
import {
  DESTINATION,
  ELSEWHERE,
  FIRST,
  HERE,
  LOOP_CONDITIONS,
  SECOND,
  candidateTabs,
  clickMap,
  clickSegment,
  generate,
  linesOn,
  marksAt,
  renderHome,
  route,
  section,
  selectDestination,
  selectedSectionOnMap,
  serveHome,
} from "@/testing/homePage";
import { mapOnScreen, type PointedFeature } from "@/testing/maplibre";
import { makeGenerationConditions, makeRouteSegment } from "@/testing/routeFixtures";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

describe("地図で扱えること", () => {
  it("地図を押したときの意味は効いているパネルで決まる: 「ルート設定」の条件タブは選んでいる地点を置き、ほかのタブ・閉じている間は置かない", async () => {
    const { user } = renderHome();
    await selectDestination(user);
    clickMap(DESTINATION);
    expect(marksAt(DESTINATION)).toEqual([expect.objectContaining({ draggable: true })]);
    expect(screen.getByRole("button", { name: "目的地を消す" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "＋ 経由地" }));
    await user.click(screen.getByRole("tab", { name: "負担" }));
    clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toEqual([]);
    expect(marksAt(DESTINATION)).toEqual([expect.objectContaining({ draggable: false })]);

    await user.click(screen.getByRole("tab", { name: "条件" }));
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    expect(screen.queryByRole("button", { name: "ルート設定" })).toBeNull();
    clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toEqual([]);
    expect(marksAt(DESTINATION)).toEqual([expect.objectContaining({ draggable: false })]);

    await user.click(screen.getByRole("button", { name: "パネルを開く" }));
    clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toEqual([expect.objectContaining({ draggable: true })]);
    expect(screen.getByRole("button", { name: "経由地1 地図で選んだ地点" })).toBeInTheDocument();
  });

  it("PC で2つの区分を開いているときは最後に触った区分が効いてその題に添える", async () => {
    const { user } = renderHome();
    expect(section("ルート設定")).toHaveAccessibleDescription("地図で操作中");
    expect(section("ルート結果")).not.toHaveAccessibleDescription();

    jobs.respond([FIRST, SECOND], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(2));
    // 結果が届いたら「ルート結果」が効く。
    expect(section("ルート結果")).toHaveAccessibleDescription("地図で操作中");
    expect(section("ルート設定")).not.toHaveAccessibleDescription();
    clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "出発地 現在地" }));
    await user.keyboard("{Escape}");
    expect(section("ルート設定")).toHaveAccessibleDescription("地図で操作中");
    clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toHaveLength(1);
  });

  it("区間を押すと、「ルート結果」が効いている間も閉じている間も地図の小窓に中身を出し、「ルート設定」が効いている間は出さない", async () => {
    const { user } = renderHome();
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");

    clickSegment(drawnSegment, HERE);
    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toBeInTheDocument();
    clickMap(ELSEWHERE);

    await user.click(screen.getByRole("button", { name: "出発地 現在地" }));
    await user.keyboard("{Escape}");
    clickSegment(drawnSegment, HERE);
    expect(screen.queryByRole("group", { name: "区間の小窓の上の帯" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    clickSegment(drawnSegment, HERE);
    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toBeInTheDocument();
  });

  it("区間を選んでいる間は、地図にその区間の範囲の縁取りを出し、外すと消す。地図で区間を押すと、縁取りは候補の区間の道なりの形になる（地図の区間の線は形の外の中身を持たない）", async () => {
    // 道なりの形が、始点と終点を結ぶ直線と違う区間。
    const curved = makeRouteSegment({
      start_latitude: 35.7,
      start_longitude: 139.7,
      end_latitude: 35.7,
      end_longitude: 139.71,
      distance_km: 1,
      geometry: {
        type: "LineString",
        coordinates: [
          [139.7, 35.7],
          [139.705, 35.702],
          [139.71, 35.7],
        ],
      },
      point_distances_m: [0, 500, 1000],
    });
    const { user } = renderHome();
    jobs.respond([route("curved", { segments: [curved], geometry: curved.geometry! })], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    expect(selectedSectionOnMap()).toEqual([]);

    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");
    clickSegment(drawnSegment, HERE);
    expect(selectedSectionOnMap()).toEqual([curved.geometry!.coordinates]);

    clickMap(ELSEWHERE);
    expect(selectedSectionOnMap()).toEqual([]);
  });

  it("効いているパネルが別のパネルへ移ると、前のパネルで地図に出した選択（選んだ区間・小窓）を外し、閉じるだけなら外さない", async () => {
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("checkbox", { name: "補給・休憩" }));
    await user.keyboard("{Escape}");
    await selectDestination(user);
    const shop: PointedFeature = {
      layer: sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "supply_poi"),
      properties: { name: "角の店", kind: "convenience" },
      geometry: { type: "Point", coordinates: [DESTINATION.longitude, DESTINATION.latitude] },
    };
    clickMap(DESTINATION, [shop]);
    jobs.respond(
      [FIRST],
      makeGenerationConditions({ latitude: HERE.latitude, longitude: HERE.longitude, destination: DESTINATION }),
    );
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");

    // 「ルート結果」で選んだ区間は、「ルート設定」の見るだけのタブへ移ると小窓に出ず、戻っても選ばれていない。
    clickSegment(drawnSegment, HERE);
    await user.click(screen.getByRole("tab", { name: "負担" }));
    expect(screen.queryByRole("group", { name: "区間の小窓の上の帯" })).toBeNull();
    await user.click(candidateTabs()[0]);
    expect(selectedSectionOnMap()).toEqual([]);

    // 見るだけのタブで開いた点の小窓は、「ルート結果」へ移ると消える。
    await user.click(screen.getByRole("tab", { name: "負担" }));
    clickMap(DESTINATION, [shop]);
    expect(await screen.findByRole("link", { name: "角の店" })).toBeInTheDocument();
    await user.click(candidateTabs()[0]);
    expect(screen.queryByRole("link", { name: "角の店" })).toBeNull();

    // 閉じるだけなら、「ルート結果」で選んだ区間を地図の小窓で読める。
    clickSegment(drawnSegment, HERE);
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toBeInTheDocument();
  });
});

describe("ルートを収める", () => {
  it("生成すると選んでいる先頭の1本へ収め、候補のタブ（今選んでいるタブも）を押すとその1本へ収め直し、地図の候補の線を押して選んだときは収め直さない", async () => {
    const { user } = renderHome();
    jobs.respond([FIRST, SECOND], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(2));
    // 先頭の1本は東へ、2本目は北へ伸びるので、全部の候補を収めると両方を含む四角になる。
    await waitFor(() =>
      expect(mapOnScreen().fits().at(-1)?.bounds).toEqual([
        [139.7, 35.7],
        [139.71, 35.7],
      ]),
    );

    await user.click(candidateTabs()[1]);
    expect(mapOnScreen().fits().at(-1)?.bounds).toEqual([
      [139.7, 35.7],
      [139.7, 35.71],
    ]);

    await user.click(candidateTabs()[0]);
    // 今選んでいるカードを押しても、そのルートの全体へ収め直す。
    const beforeSameCard = mapOnScreen().fits().length;
    await user.click(candidateTabs()[0]);
    expect(mapOnScreen().fits()).toHaveLength(beforeSameCard + 1);
    const fitted = mapOnScreen().fits().length;
    const [secondLine] = mapOnScreen()
      .sourceFeatures("route-candidates")
      .filter((line) => line.properties?.routeId === SECOND.id);
    clickMap(ELSEWHERE, [
      {
        layer: "route-candidates-candidateHit",
        properties: secondLine.properties ?? {},
        geometry: secondLine.geometry,
      },
    ]);
    expect(linesOn("route-selected")).toEqual([SECOND.geometry.coordinates]);
    expect(mapOnScreen().fits()).toHaveLength(fitted);
  });
});
