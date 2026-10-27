/**
 * `app/page.tsx`——トップページのうち、地図を押したときに起きること。
 *
 * 見ること: 地図を押したときの意味は効いているパネルで決まり（「ルート設定」の条件タブは選んでいる地点を置く、
 * 「ルート結果」は候補の線でそのルートを選び区間でその中身を出す、閉じている間は押した物の中身を小窓に出すだけ）、PC で
 * 2つの区分を開いていれば最後に触った区分が効いてその題に添えること、区間を選んでいる間は地図にその区間の範囲の縁取りと
 * 選んだ地点の印が出ること、効いているパネルが移ると前のパネルで地図に出した選択を外すこと。区間を押すと
 * 地図が読み込んだ点のタイルのうち区間の線から近い点を地図に描き、押した区間の小窓にその中の補給・立ち寄り先を区分のチップで出し、
 * チップでその区分の一覧（道のりの順）を開いて地図に出す・消せ、点を押すと1施設1行で名前・押した地点から見た前後・道からの距離を出すこと
 * （グラフの下の地点の詳しくには出さず、グラフで地点を選んだときは小窓も点も出さず、点のタイルを読まないズームでは出さない）。走行中は施設の位置を
 * 現在地からの残りで出すこと。施設の印を押すと
 * 小窓を施設の中身へ入れ替えて印に枠を付け、区間へ戻れること。地図は選んでいるルート1本へ収め（生成直後は先頭、タブで
 * 選び直すとその1本）、地図の候補の線を押して選んだときは収め直さないこと。
 *
 * ここで見ないもの: 地図に置く地点（ピン・名前のある点・目的地・保存した地点）は`app/page.places.test.tsx`が、小窓がいつも1つで
 * 最後に押した物の中身を出すことと道の小窓は`app/page.popups.test.tsx`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ROUTE_SEGMENT_INDEX_PROPERTY } from "@/features/map/scene/groups/routeSources";
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
  selectedPointMarks,
  selectedSectionOnMap,
  serveHome,
} from "@/testing/homePage";
import { installGeolocation } from "@/testing/geolocation";
import { mapOnScreen, type PointedFeature } from "@/testing/maplibre";
import { makeGenerationConditions, makeRouteSegment, routeThrough } from "@/testing/routeFixtures";
import palette from "@/types/generated/palette.json";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

describe("地図で扱えること", () => {
  it("地図を押したときの意味は効いているパネルで決まる: 「ルート設定」の条件タブは選んでいる地点を置き、ほかのタブ・閉じている間は置かない", async () => {
    const { user } = renderHome();
    await selectDestination(user);
    await clickMap(DESTINATION);
    expect(marksAt(DESTINATION)).toEqual([expect.objectContaining({ draggable: true })]);
    expect(screen.getByRole("button", { name: "目的地を消す" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "経由地を足す" }));
    await user.click(screen.getByRole("tab", { name: "重み" }));
    await clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toEqual([]);
    expect(marksAt(DESTINATION)).toEqual([expect.objectContaining({ draggable: false })]);

    await user.click(screen.getByRole("tab", { name: "条件" }));
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    expect(screen.queryByRole("button", { name: "ルート設定" })).toBeNull();
    await clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toEqual([]);
    expect(marksAt(DESTINATION)).toEqual([expect.objectContaining({ draggable: false })]);

    await user.click(screen.getByRole("button", { name: "パネルを開く" }));
    await clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toEqual([expect.objectContaining({ draggable: true })]);
    expect(screen.getByRole("button", { name: "経由地1: 地図で選んだ地点" })).toBeInTheDocument();
  });

  it("PC で2つの区分を開いているときは最後に触った区分が効いてその題に添え、「ルート結果」では候補の線を押すとそのルートを選ぶ", async () => {
    const { user } = renderHome();
    expect(section("ルート設定")).toHaveAccessibleDescription("地図で操作中");
    expect(section("ルート結果")).not.toHaveAccessibleDescription();

    jobs.respond([FIRST, SECOND], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(2));
    // 結果が届いたら「ルート結果」が効く。
    expect(section("ルート結果")).toHaveAccessibleDescription("地図で操作中");
    expect(section("ルート設定")).not.toHaveAccessibleDescription();
    const [secondLine] = mapOnScreen()
      .sourceFeatures("route-candidates")
      .filter((line) => line.properties?.routeId === SECOND.id);
    await clickMap(ELSEWHERE, [
      {
        layer: "route-candidates-candidateHit",
        properties: secondLine.properties ?? {},
        geometry: secondLine.geometry,
      },
    ]);
    expect(linesOn("route-selected")).toEqual([SECOND.geometry.coordinates]);
    expect(marksAt(ELSEWHERE)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "出発地: 現在地" }));
    expect(section("ルート設定")).toHaveAccessibleDescription("地図で操作中");
    await clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toHaveLength(1);
  });

  it("区間を押すと、「ルート結果」が効いている間も閉じている間も地図の小窓に中身を出し、「ルート設定」が効いている間は出さない", async () => {
    const { user } = renderHome();
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");

    await clickSegment(drawnSegment, HERE);
    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toBeInTheDocument();
    await clickMap(ELSEWHERE);

    await user.click(screen.getByRole("button", { name: "出発地: 現在地" }));
    await clickSegment(drawnSegment, HERE);
    expect(screen.queryByRole("group", { name: "区間の小窓の上の帯" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    await clickSegment(drawnSegment, HERE);
    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toBeInTheDocument();
  });

  it("区間を選んでいる間は、地図にその区間の範囲の縁取りと選んだ地点の印を出し、外すと消す。地図で区間を押すと、縁取りは候補の区間の道なりの形になる（地図の区間の線は形の外の中身を持たない）", async () => {
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
    });
    const { user } = renderHome();
    jobs.respond([route("curved", { segments: [curved], geometry: curved.geometry! })], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    expect(selectedSectionOnMap()).toEqual([]);

    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");
    await clickSegment(drawnSegment, HERE);
    expect(selectedSectionOnMap()).toEqual([curved.geometry!.coordinates]);
    const [pin] = selectedPointMarks();
    expect(pin.element.querySelector("path")).toHaveAttribute("fill", palette.semantic.selected_point);

    await clickMap(ELSEWHERE);
    expect(selectedSectionOnMap()).toEqual([]);
    expect(selectedPointMarks()).toEqual([]);
  });

  it("効いているパネルが別のパネルへ移ると、前のパネルで地図に出した選択（選んだ区間・小窓）を外し、閉じるだけなら外さない", async () => {
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("checkbox", { name: "補給・休憩ポイント" }));
    await user.keyboard("{Escape}");
    await selectDestination(user);
    const shop: PointedFeature = {
      layer: sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "supply_poi"),
      properties: { name: "角の店", kind: "convenience" },
      geometry: { type: "Point", coordinates: [DESTINATION.longitude, DESTINATION.latitude] },
    };
    await clickMap(DESTINATION, [shop]);
    jobs.respond(
      [FIRST],
      makeGenerationConditions({ latitude: HERE.latitude, longitude: HERE.longitude, destination: DESTINATION }),
    );
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");

    // 「ルート結果」で選んだ区間は、「ルート設定」の見るだけのタブへ移ると小窓に出ず、戻っても選ばれていない。
    await clickSegment(drawnSegment, HERE);
    await user.click(screen.getByRole("tab", { name: "重み" }));
    expect(screen.queryByRole("group", { name: "区間の小窓の上の帯" })).toBeNull();
    await user.click(candidateTabs()[0]);
    expect(selectedPointMarks()).toEqual([]);

    // 見るだけのタブで開いた点の小窓は、「ルート結果」へ移ると消える。
    await user.click(screen.getByRole("tab", { name: "重み" }));
    await clickMap(DESTINATION, [shop]);
    expect(screen.getByRole("link", { name: "角の店" })).toBeInTheDocument();
    await user.click(candidateTabs()[0]);
    expect(screen.queryByRole("link", { name: "角の店" })).toBeNull();

    // 閉じるだけなら、「ルート結果」で選んだ区間を地図の小窓で読める。
    await clickSegment(drawnSegment, HERE);
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
    await clickMap(ELSEWHERE, [
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

describe("区間の近くの施設", () => {
  // 東へ1kmずつ進む区間2つのルート。
  const NEAR = route("near", {
    ...routeThrough({ a: [139.7, 35.7], b: [139.71, 35.7], c: [139.72, 35.7] }, ["a", "b", "c"], [1, 1]),
    distance_km: 2,
  });
  // 緯度の0.0001度は、地上で約11m。
  const point = (lngLat: [number, number], properties: Record<string, unknown>): GeoJSON.Feature<GeoJSON.Point> => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: lngLat },
    properties,
  });

  /** 地図が読み込んだ点のタイル。2つ目の区間（東経139.71〜139.72）の近くに、補給（同じ所のコンビニ2つ・トイレ）・立ち寄り先・
   * 停止要因・事故と、地図の点の層の行に当たらない値の点がある。区間から約220m離れたコンビニと、1つ目の区間の横の店は遠い。 */
  function placeTiles() {
    const map = mapOnScreen();
    map.placeTileFeatures(POINT_TILE_SOURCES.poi.sourceId, [
      point([139.713, 35.7001], { kind: "convenience", name: "ローソン 渋谷店" }),
      point([139.713, 35.70007], { kind: "convenience", name: "ファミリーマート" }),
      point([139.718, 35.7], { kind: "toilets" }),
      point([139.719, 35.7], { kind: "vanished" }),
      point([139.715, 35.702], { kind: "convenience", name: "遠いコンビニ" }),
      point([139.705, 35.7], { kind: "convenience", name: "前の区間の店" }),
      point([139.716, 35.7], { kind: "traffic_signals" }),
    ]);
    map.placeTileFeatures(POINT_TILE_SOURCES.stop_place.sourceId, [
      point([139.712, 35.70005], { group: "eat_drink", name: "そば処" }),
    ]);
    map.placeTileFeatures(POINT_TILE_SOURCES.accident.sourceId, [
      point([139.715, 35.7], { involves_bicycle: true, fatal: true }),
    ]);
  }

  const ROUTE_VIEW = { west: 139.69, south: 35.69, east: 139.73, north: 35.71 };

  /** 地図に描いた近くの点の、レイヤーごとの位置（描いていないレイヤーは載せない）。 */
  function sidePointsOnMap() {
    return Object.fromEntries(
      mapOnScreen()
        .visibleLayerIds()
        // 点の層だけを見る（引いた縮尺の丸・束ねた数の字の層は、点に添える層）。
        .filter((id) => id.includes("-side-") && !id.includes(":"))
        .map((id) => [
          id,
          mapOnScreen()
            .drawnTileFeatures(id)
            .map((feature) => feature.geometry.coordinates),
        ])
        .filter(([, coordinates]) => coordinates.length > 0),
    );
  }

  async function pressSecondSegment(user: Parameters<typeof generate>[0]) {
    jobs.respond([NEAR], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    placeTiles();
    act(() => mapOnScreen().moveTo(ROUTE_VIEW, 14));
    const [, second] = mapOnScreen().sourceFeatures("route-segments");
    // 区間の中ほど（1.5km）を押す。施設の位置は、ここから見た前後で出る。
    await clickSegment(second, { latitude: 35.7, longitude: 139.715 });
  }

  it("区間を選んでいる間は、地図で押してもグラフで選んでも、区間の線から近い点を「表示」に関わらず点の層ごとに描き、選びを外すと消す", async () => {
    const { user } = renderHome();
    await pressSecondSegment(user);
    expect(sidePointsOnMap()).toEqual({
      "point-poi-side-stop_poi": [[139.716, 35.7]],
      "point-poi-side-supply_poi": [
        [139.713, 35.7001],
        [139.713, 35.70007],
        [139.718, 35.7],
      ],
      "point-stop_place-side-stop_place": [[139.712, 35.70005]],
      "point-accident-side-accident_point": [[139.715, 35.7]],
    });

    await clickMap(ELSEWHERE);
    expect(sidePointsOnMap()).toEqual({});

    fireEvent.keyDown(screen.getByRole("slider", { name: /^道のりに沿った難易度/ }), { key: "Home" });
    expect(sidePointsOnMap()).toEqual({ "point-poi-side-supply_poi": [[139.705, 35.7]] });
  });

  it("描いた名前のある点を押すと、押した地点から見た前後と道からの距離を添えた点の小窓を出して区間へ戻れ、名前の無い点だけの所を押すと下の区間を開く", async () => {
    const { user } = renderHome();
    await pressSecondSegment(user);
    const drawn = (layer: string, name: string | undefined): PointedFeature => {
      const feature = mapOnScreen()
        .drawnTileFeatures(layer)
        .find((candidate) => candidate.properties?.name === name)!;
      return { layer, properties: feature.properties ?? {}, geometry: feature.geometry };
    };

    await clickMap(ELSEWHERE, [drawn("point-poi-side-supply_poi", "ファミリーマート")]);
    expect(screen.getByRole("link", { name: "ファミリーマート" }).closest("li")!.textContent).toBe(
      "ファミリーマート押した地点から 200m手前道からの距離 8m",
    );
    await user.click(
      within(screen.getByRole("group", { name: "点の小窓の上の帯" })).getByRole("button", { name: "‹ 区間" }),
    );
    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toBeInTheDocument();

    const [, second] = mapOnScreen().sourceFeatures("route-segments");
    await clickMap(ELSEWHERE, [
      drawn("point-poi-side-supply_poi", undefined),
      { layer: "route-segments-detailHit", properties: second.properties ?? {}, geometry: second.geometry },
    ]);
    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toBeInTheDocument();
  });

  it("走行中は、描いた点の小窓の位置を、押した地点でなく現在地からの残りで出す", async () => {
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    jobs.respond([NEAR], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    placeTiles();
    act(() => mapOnScreen().moveTo(ROUTE_VIEW, 14));
    await user.click(screen.getByRole("button", { name: "走行モード" }));
    // 現在地は0.4kmの所。
    geolocation.deliver({ latitude: 35.7, longitude: 139.704, accuracy: 20 });
    await user.click(screen.getByRole("button", { name: "ルート" }));

    // 走った所で線が分かれるので、2つ目の区間は始点からの道のりで引く。
    const second = mapOnScreen()
      .sourceFeatures("route-segments")
      .find((feature) => feature.properties?.[ROUTE_SEGMENT_INDEX_PROPERTY] === 1)!;
    await clickSegment(second, { latitude: 35.7, longitude: 139.715 });
    const familyMart = mapOnScreen()
      .drawnTileFeatures("point-poi-side-supply_poi")
      .find((feature) => feature.properties?.name === "ファミリーマート")!;
    await clickMap(ELSEWHERE, [
      { layer: "point-poi-side-supply_poi", properties: familyMart.properties ?? {}, geometry: familyMart.geometry },
    ]);

    expect(screen.getByRole("link", { name: "ファミリーマート" }).closest("li")!.textContent).toBe(
      "ファミリーマート現在地から あと900m道からの距離 8m",
    );
  });
});
