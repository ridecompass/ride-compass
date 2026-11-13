/**
 * `app/page.tsx`——トップページのうち、地図を押したときに起きること。
 *
 * 見ること: 地図を押したときの意味は効いているパネルで決まり（「ルート設定」の条件タブは選んでいる地点を置く、
 * 「ルート結果」は候補の線でそのルートを選び区間でその中身を出す、閉じている間は押した物の中身を小窓に出すだけ）、PC で
 * 2つの区分を開いていれば最後に触った区分が効いてその題に添えること、区間を選んでいる間は地図にその区間の範囲の縁取りが
 * 出ること、効いているパネルが移ると前のパネルで地図に出した選択を外すこと。ルートを選んでいる間は「表示」で出した点の層を
 * ルートの線から近い点だけに描き（区間を選んでも変えず、「ルート後も周りを出す」で地図全体へ戻す）、描いた名前のある点を押すと
 * 道からの距離を添えた点の小窓を出して区間へ戻れ、名前の無い点だけの所を押すと下の区間を開くこと。走行中は点の小窓の位置を
 * 現在地からの残りで出し、同じ道を2度通るルートでは現在地から続く側で数えること。地図は選んでいるルート1本へ収め（生成直後は先頭、タブで選び直すとその1本）、地図の候補の線を押して
 * 選んだときは収め直さないこと。
 *
 * ここで見ないもの: 地図に置く地点（ピン・名前のある点・目的地・保存した地点）は`app/page.places.test.tsx`が、小窓がいつも1つで
 * 最後に押した物の中身を出すことと道の小窓は`app/page.popups.test.tsx`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { act, screen, waitFor, within } from "@testing-library/react";
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
import { onBackend } from "@/testing/backendServer";
import { installGeolocation } from "@/testing/geolocation";
import { mapOnScreen, type PointedFeature } from "@/testing/maplibre";
import { makeGenerationConditions, makeRouteSegment, routeThrough } from "@/testing/routeFixtures";

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

    await user.click(screen.getByRole("button", { name: "経由地を足す" }));
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
    expect(screen.getByRole("button", { name: "経由地1: 地図で選んだ地点" })).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "出発地: 現在地" }));
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

    await user.click(screen.getByRole("button", { name: "出発地: 現在地" }));
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
    await user.click(screen.getByRole("checkbox", { name: "補給・休憩ポイント" }));
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

describe("ルートの近くの点", () => {
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

  /** 地図が読み込んだ点のタイル。ルートの近くに、補給（同じ所のコンビニ2つ・トイレ・1つ目の区間の横の店）・立ち寄り先・停止要因・
   * 事故と、地図の点の層の行に当たらない値の点がある。ルートから約220m離れたコンビニは遠い。 */
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
  const SUPPLY = sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "supply_poi");
  const STOP = sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "stop_poi");

  /** 地図に描いた点の、点の層ごとの位置（描いていない層は載せない）。 */
  function pointsOnMap() {
    return Object.fromEntries(
      [SUPPLY, STOP]
        .filter((id) => mapOnScreen().visibleLayerIds().includes(id))
        .map((id) => [
          id,
          mapOnScreen()
            .drawnTileFeatures(id)
            .map((feature) => feature.geometry.coordinates),
        ])
        .filter(([, coordinates]) => coordinates.length > 0),
    );
  }

  async function showLayers(user: Parameters<typeof generate>[0], names: readonly string[]) {
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    for (const name of names) await user.click(screen.getByRole("checkbox", { name }));
    await user.keyboard("{Escape}");
  }

  async function generateNear(user: Parameters<typeof generate>[0]) {
    jobs.respond([NEAR], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    placeTiles();
    act(() => mapOnScreen().moveTo(ROUTE_VIEW, 14));
  }

  function pressSecondSegment() {
    const [, second] = mapOnScreen().sourceFeatures("route-segments");
    // 区間の中ほど（1.5km）を押す。
    clickSegment(second, { latitude: 35.7, longitude: 139.715 });
  }

  it("ルートを選んでいる間は、「表示」で出した点の層をルート全体の近くだけに描き、区間を選んでも変えず、「ルート後も周りを出す」で地図全体へ戻す", async () => {
    const { user } = renderHome();
    await showLayers(user, ["補給・休憩ポイント"]);
    await generateNear(user);
    const nearRoute = {
      [SUPPLY]: [
        [139.713, 35.7001],
        [139.713, 35.70007],
        [139.718, 35.7],
        [139.705, 35.7],
      ],
    };
    await waitFor(() => expect(pointsOnMap()).toEqual(nearRoute));

    pressSecondSegment();
    expect(pointsOnMap()).toEqual(nearRoute);

    await showLayers(user, ["ルート後も周りを出す"]);
    expect(pointsOnMap()).toEqual({
      [SUPPLY]: [
        [139.713, 35.7001],
        [139.713, 35.70007],
        [139.718, 35.7],
        [139.715, 35.702],
        [139.705, 35.7],
      ],
    });
  });

  it("「表示」で出していない層と、内訳で外した行の点は、ルートの近くにも描かない", async () => {
    const { user } = renderHome();
    await generateNear(user);
    expect(pointsOnMap()).toEqual({});

    // 停止要因は縮尺15から描く層で、それより引いた地図では内訳に行を出さない。
    act(() => mapOnScreen().moveTo(ROUTE_VIEW, 16));
    await showLayers(user, ["停止要因", "補給・休憩ポイント"]);
    await waitFor(() => expect(pointsOnMap()).toHaveProperty(STOP));
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("button", { name: "停止要因の凡例" }));
    const details = screen.getByRole("region", { name: "停止要因の内訳" });
    await user.click(within(details).getByRole("checkbox", { name: /^信号/ }));

    await waitFor(() => expect(pointsOnMap()).not.toHaveProperty(STOP));
    expect(pointsOnMap()).toHaveProperty(SUPPLY);
  });

  it("描いた名前のある点を押すと、道からの距離を添えた点の小窓を出して区間へ戻れ、名前の無い点だけの所を押すと下の区間を開く", async () => {
    const { user } = renderHome();
    await showLayers(user, ["補給・休憩ポイント"]);
    await generateNear(user);
    pressSecondSegment();
    const drawn = (name: string | undefined): PointedFeature => {
      const feature = mapOnScreen()
        .drawnTileFeatures(SUPPLY)
        .find((candidate) => candidate.properties?.name === name)!;
      return { layer: SUPPLY, properties: feature.properties ?? {}, geometry: feature.geometry };
    };

    const asked = onBackend("GET", "/api/place-link", () => Response.json({ url: "https://maps.example/familymart" }));
    const familyMart = drawn("ファミリーマート");
    clickMap(ELSEWHERE, [familyMart]);
    const link = await screen.findByRole("link", { name: "ファミリーマート" });
    expect(link.closest("li")!.textContent).toBe("ファミリーマート道からの距離 8m");
    // 外の地図のリンクは、点の名前と位置で backend に引いた先を開く。
    expect(link).toHaveAttribute("href", "https://maps.example/familymart");
    const [longitude, latitude] = (familyMart.geometry as GeoJSON.Point).coordinates;
    expect(asked.map(({ query }) => [query.name, Number(query.latitude), Number(query.longitude)])).toEqual([
      ["ファミリーマート", latitude, longitude],
    ]);
    await user.click(
      within(screen.getByRole("group", { name: "点の小窓の上の帯" })).getByRole("button", { name: "‹ 区間" }),
    );
    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toBeInTheDocument();

    const [, second] = mapOnScreen().sourceFeatures("route-segments");
    clickMap(ELSEWHERE, [
      drawn(undefined),
      { layer: "route-segments-detailHit", properties: second.properties ?? {}, geometry: second.geometry },
    ]);
    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toBeInTheDocument();
  });

  it("走行中は、点の小窓の位置を現在地からの残りで出し、同じ道を2度通るルートでは現在地から続く側で数える", async () => {
    // 東へ1km進んで同じ道を戻るルート。店は行きの0.5km・帰りの1.5kmの所にある。
    const OUT_AND_BACK = route("out-and-back", {
      ...routeThrough({ a: [139.7, 35.7], b: [139.71, 35.7] }, ["a", "b", "a"], [1, 1]),
      distance_km: 2,
    });
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    await showLayers(user, ["補給・休憩ポイント"]);
    jobs.respond([OUT_AND_BACK], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    mapOnScreen().placeTileFeatures(POINT_TILE_SOURCES.poi.sourceId, [
      point([139.705, 35.7001], { kind: "convenience", name: "ファミリーマート" }),
    ]);
    act(() => mapOnScreen().moveTo(ROUTE_VIEW, 14));
    await user.click(screen.getByRole("button", { name: "走行モード" }));
    const rideTo = (longitude: number, timestamp: number) =>
      geolocation.deliver({ latitude: 35.7, longitude, accuracy: 5, timestamp });
    const familyMartPosition = async () => {
      const familyMart = mapOnScreen()
        .drawnTileFeatures(SUPPLY)
        .find((feature) => feature.properties?.name === "ファミリーマート")!;
      clickMap(ELSEWHERE, [{ layer: SUPPLY, properties: familyMart.properties ?? {}, geometry: familyMart.geometry }]);
      return (await screen.findByRole("link", { name: "ファミリーマート" })).closest("li")!.textContent;
    };

    // 行きの0.4kmの所。
    rideTo(139.704, 1000);
    await waitFor(() => expect(pointsOnMap()).toHaveProperty(SUPPLY));
    expect(await familyMartPosition()).toBe("ファミリーマート現在地から あと100m道からの距離 11m");

    // 折り返して帰りの1.3kmの所。
    rideTo(139.71, 2000);
    rideTo(139.707, 3000);
    await waitFor(async () =>
      expect(await familyMartPosition()).toBe("ファミリーマート現在地から あと200m道からの距離 11m"),
    );
  });
});
