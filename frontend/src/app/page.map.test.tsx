/**
 * `app/page.tsx`——トップページのうち、地図を押したときに起きること。
 *
 * 見ること: 地図を押したときの意味は効いているパネルで決まり（「ルート設定」の条件タブは選んでいる地点を置く、
 * 「ルート結果」は候補の線でそのルートを選び区間でその中身を出す、閉じている間は押した物の中身を小窓に出すだけ）、PC で
 * 2つの区分を開いていれば最後に触った区分が効いてその題に添えること、区間を選んでいる間は地図にその区間の範囲の縁取りと
 * 選んだ地点の印が出ること、効いているパネルが移ると前のパネルで地図に出した選択を外すこと。区間を押すと
 * 押した区間の小窓の「探す」でその区間の近くの施設を引いて地図に描き、種類ごとに出す・消せ、点を押すと名前と道からの距離を出すこと
 * （区間を押しただけでは引かず、グラフの下の地点の詳しくには出さず、グラフで地点を選んだときは小窓を出さない）。道の小窓を別の道へ
 * 押し替えると、前の道で押した評価を新しい道へ持ち越さないこと。地図は選んでいるルート1本へ収め（生成直後は先頭、タブで
 * 選び直すとその1本）、地図の候補の線を押して選んだときは収め直さないこと。
 *
 * ここで見ないもの: 地図に置く地点（ピン・名前のある点・目的地・保存した地点）は`app/page.places.test.tsx`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  showRoadSurface,
} from "@/testing/homePage";
import { heldReplies, onBackend } from "@/testing/backendServer";
import { mapOnScreen } from "@/testing/maplibre";
import { inspectorResult } from "@/testing/roadInspector";
import { makeGenerationConditions, makeRouteSegment, routeThrough } from "@/testing/routeFixtures";
import { settle } from "@/testing/settle";
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
    clickMap(DESTINATION);
    expect(marksAt(DESTINATION)).toEqual([expect.objectContaining({ draggable: true })]);
    expect(screen.getByRole("button", { name: "目的地を消す" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "経由地を足す" }));
    await user.click(screen.getByRole("tab", { name: "重み" }));
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
    clickMap(ELSEWHERE, [
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
    clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toHaveLength(1);
  });

  it("区間を押すと、「ルート結果」が効いている間はその中に、閉じている間は地図の小窓に中身を出し、「ルート設定」が効いている間は出さない", async () => {
    const { user } = renderHome();
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");

    clickSegment(drawnSegment, HERE);
    await user.click(screen.getByRole("button", { name: "区間の選択を解除" }));

    await user.click(screen.getByRole("button", { name: "出発地: 現在地" }));
    clickSegment(drawnSegment, HERE);
    expect(screen.queryByText(/km地点/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    clickSegment(drawnSegment, HERE);
    expect(screen.getByText(/km地点/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "区間の選択を解除" })).toBeNull();
  });

  it("区間を選んでいる間は、地図にその区間の範囲の縁取りと選んだ地点の印を出し、外すと消す。地図で押した区間（形を持たない写し）でも、縁取りは候補の区間の道なりの形になる", async () => {
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
    const [pin] = selectedPointMarks();
    expect(pin.element.querySelector("path")).toHaveAttribute("fill", palette.semantic.selected_point);

    await user.click(screen.getByRole("button", { name: "区間の選択を解除" }));
    expect(selectedSectionOnMap()).toEqual([]);
    expect(selectedPointMarks()).toEqual([]);
  });

  it("効いているパネルが別のパネルへ移ると、前のパネルで地図に出した選択（選んだ区間・小窓）を外し、閉じるだけなら外さない", async () => {
    const { user } = renderHome();
    await selectDestination(user);
    clickMap(DESTINATION);
    jobs.respond(
      [FIRST],
      makeGenerationConditions({ latitude: HERE.latitude, longitude: HERE.longitude, destination: DESTINATION }),
    );
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");

    // 「ルート結果」で選んだ区間は、「ルート設定」の見るだけのタブへ移ると小窓に出ず、戻っても選ばれていない。
    clickSegment(drawnSegment, HERE);
    await user.click(screen.getByRole("tab", { name: "重み" }));
    expect(screen.queryByText(/km地点/)).toBeNull();
    await user.click(candidateTabs()[0]);
    expect(screen.queryByRole("button", { name: "区間の選択を解除" })).toBeNull();

    // 見るだけのタブで開いた地点の小窓は、「ルート結果」へ移ると消える。
    await user.click(screen.getByRole("tab", { name: "重み" }));
    await user.click(marksAt(DESTINATION)[0].element);
    expect(screen.getByText("目的地: 地図で選んだ地点")).toBeInTheDocument();
    await user.click(candidateTabs()[0]);
    expect(screen.queryByText("目的地: 地図で選んだ地点")).toBeNull();

    // 閉じるだけなら、「ルート結果」で選んだ区間を地図の小窓で読める。
    clickSegment(drawnSegment, HERE);
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    expect(screen.getByText(/km地点/)).toBeInTheDocument();
  });
});

describe("ルートを収める", () => {
  it("生成すると選んでいる先頭の1本へ収め、候補のタブで選び直すとその1本へ収め直し、地図の候補の線を押して選んだときは収め直さない", async () => {
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

describe("道の小窓", () => {
  it("評価を開いた道から別の道へ押し替えると、その道の評価は押すまで取りに行かない", async () => {
    const asked: unknown[] = [];
    onBackend("POST", "/api/region/axis-inspector", ({ body }) => {
      asked.push(body);
      return Response.json(inspectorResult());
    });
    const { user } = renderHome();
    await showRoadSurface(user);
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    clickMap(HERE, [{ layer: "road-tiles-surface", properties: { osm_way_id: 1, feature_key: "1" } }]);
    await user.click(screen.getByRole("button", { name: "この道の評価を見る" }));
    expect(await screen.findByText(/この道全体で見た難易度/)).toBeInTheDocument();

    clickMap(ELSEWHERE, [{ layer: "road-tiles-surface", properties: { osm_way_id: 2, feature_key: "2" } }]);
    expect(await screen.findByRole("button", { name: "この道の評価を見る" })).toBeInTheDocument();
    await settle();
    expect(asked).toEqual([expect.objectContaining({ osm_way_id: 1 })]);
  });
});

describe("区間の近くの施設", () => {
  // 東へ1kmずつ進む区間2つのルート。
  const NEAR = route("near", {
    ...routeThrough({ a: [139.7, 35.7], b: [139.71, 35.7], c: [139.72, 35.7] }, ["a", "b", "c"], [1, 1]),
    distance_km: 2,
  });

  // 2つ目の区間の近くの点: 事故・同じ所のコンビニ2つ・トイレと、地図の点の層の行に当たらない値の点。種類は地図の「表示」の
  // 並びと違う順で返す。
  const NEARBY_POINTS = [
    {
      distance_km: 1.5,
      offset_m: 30,
      layer: "accident_point",
      properties: { involves_bicycle: true, fatal: true },
      latitude: 35.7,
      longitude: 139.715,
    },
    {
      distance_km: 1.3,
      offset_m: 12,
      layer: "supply_poi",
      properties: { kind: "convenience", name: "ローソン 渋谷店" },
      latitude: 35.7,
      longitude: 139.713,
    },
    {
      distance_km: 1.3,
      offset_m: 8,
      layer: "supply_poi",
      properties: { kind: "convenience", name: "ファミリーマート" },
      latitude: 35.7,
      longitude: 139.713,
    },
    {
      distance_km: 1.8,
      offset_m: 5,
      layer: "supply_poi",
      properties: { kind: "toilets" },
      latitude: 35.7,
      longitude: 139.718,
    },
    {
      distance_km: 1.9,
      offset_m: 4,
      layer: "supply_poi",
      properties: { kind: "vanished" },
      latitude: 35.7,
      longitude: 139.719,
    },
  ];

  /** 地図に描いた近くの点の、ソースごとの位置。 */
  function sidePointsOnMap() {
    return Object.fromEntries(
      mapOnScreen()
        .sourceIds()
        .filter((id) => id.startsWith("side-point-"))
        .map((id) => [
          id,
          mapOnScreen()
            .sourceFeatures(id)
            .map((feature) => (feature.geometry as GeoJSON.Point).coordinates),
        ]),
    );
  }

  async function pressSecondSegment(user: Parameters<typeof generate>[0]) {
    jobs.respond([NEAR], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const [, second] = mapOnScreen().sourceFeatures("route-segments");
    clickSegment(second, HERE);
    // 「ルート結果」が効いている間も、押した区間の小窓に近くの施設を探す所だけを出す（中身はグラフの下が出す）。
    const nearby = await screen.findByRole("group", { name: "近くの施設" });
    expect(screen.queryByText(/km地点/)).toBeNull();
    return nearby;
  }

  it("区間を押した小窓の「探す」で近くの施設を引き、届くと地図の点と同じ行ごとに描いて種類ごとの件数のチップを出し、チップでその種類を消せ、選びを外すと消す", async () => {
    const { user } = renderHome();
    const held = heldReplies();
    onBackend("POST", "/api/routes/side-points", held.reply);

    const nearby = await pressSecondSegment(user);
    // 区間を押しただけでは引かず、押した区間の小窓に「探す」を出す。グラフの下の地点の詳しくには出さない。
    await settle();
    expect(held.arrived()).toBe(0);
    expect(sidePointsOnMap()).toEqual({});
    expect(
      within(screen.getByRole("group", { name: "選んだ地点の詳しく" })).queryByRole("group", { name: "近くの施設" }),
    ).toBeNull();
    await user.click(within(nearby).getByRole("button", { name: "探す" }));
    expect(within(nearby).getByText("読み込み中")).toBeInTheDocument();

    await held.answer(0, Response.json({ points: NEARBY_POINTS }));
    const supply = await within(nearby).findByRole("button", { name: "補給・休憩ポイント 3" });
    expect(
      within(nearby)
        .getAllByRole("button")
        .map((chip) => chip.textContent),
    ).toEqual(["補給・休憩ポイント 3", "事故[警察庁統計] 1"]);
    expect(supply).toHaveAttribute("aria-pressed", "true");
    expect(sidePointsOnMap()).toEqual({
      "side-point-accident_point-bicycle": [[139.715, 35.7]],
      "side-point-supply_poi-convenience": [
        [139.713, 35.7],
        [139.713, 35.7],
      ],
      "side-point-supply_poi-toilets": [[139.718, 35.7]],
    });

    await user.click(supply);
    expect(supply).toHaveAttribute("aria-pressed", "false");
    expect(sidePointsOnMap()).toEqual({ "side-point-accident_point-bicycle": [[139.715, 35.7]] });

    // 区間を選び直すと、消した種類も出し直す。
    const [, second] = mapOnScreen().sourceFeatures("route-segments");
    clickSegment(second, HERE);
    expect(
      await within(screen.getByRole("group", { name: "近くの施設" })).findByRole("button", {
        name: "補給・休憩ポイント 3",
        pressed: true,
      }),
    ).toBeInTheDocument();

    // グラフで地点を選んだときは、小窓を出さない（なぞるたびに付いて回らない）。
    fireEvent.keyDown(screen.getByRole("slider", { name: /^道のりに沿った難易度/ }), { key: "Home" });
    expect(screen.queryByRole("group", { name: "近くの施設" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "区間の選択を解除" }));
    expect(sidePointsOnMap()).toEqual({});
  });

  it("近くの施設の点を押すと名前と道からの距離を出し、重なって束ねた印を押すと中の点を道に近い順に並べる。区間の中身が地図の小窓にあっても、点を押しただけでは区間の選びを外さず、何も無い所を押すと外す", async () => {
    const { user } = renderHome();
    onBackend("POST", "/api/routes/side-points", () => Response.json({ points: NEARBY_POINTS }));
    const nearby = await pressSecondSegment(user);
    await user.click(within(nearby).getByRole("button", { name: "探す" }));
    await within(nearby).findByRole("button", { name: "補給・休憩ポイント 3" });
    // パネルを閉じると、区間の中身は地図の小窓に出る。
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    expect(screen.queryByRole("button", { name: "区間の選択を解除" })).toBeNull();
    const [toilet] = mapOnScreen().sourceFeatures("side-point-supply_poi-toilets");

    clickMap(ELSEWHERE, [
      { layer: "side-point-supply_poi-toilets-mark", properties: toilet.properties ?? {}, geometry: toilet.geometry },
    ]);
    expect(screen.getByText(/補給・休憩ポイント: トイレ/).textContent).toBe("補給・休憩ポイント: トイレ道から5m");
    expect(screen.getByRole("group", { name: "近くの施設" })).toBeInTheDocument();
    expect(Object.keys(sidePointsOnMap())).toHaveLength(3);

    clickMap(ELSEWHERE, [
      {
        layer: "side-point-supply_poi-convenience-mark",
        properties: { cluster: true, cluster_id: 1, point_count: 2, point_count_abbreviated: "2" },
        geometry: { type: "Point", coordinates: [139.713, 35.7] },
      },
    ]);
    expect((await screen.findByText(/コンビニ 2件/)).textContent).toBe(
      "補給・休憩ポイント: コンビニ 2件ファミリーマート 道から8mローソン 渋谷店 道から12m",
    );

    clickMap(ELSEWHERE, []);
    await waitFor(() => expect(sidePointsOnMap()).toEqual({}));
    expect(screen.queryByRole("group", { name: "近くの施設" })).toBeNull();
  });

  it("引けなかったら、区間の評価はそのまま出し、近くの施設を読めなかったと出す", async () => {
    const { user } = renderHome();
    onBackend("POST", "/api/routes/side-points", () => Response.json({ detail: "失敗" }, { status: 500 }));

    const nearby = await pressSecondSegment(user);
    await user.click(within(nearby).getByRole("button", { name: "探す" }));

    expect(await within(nearby).findByText("近くの施設を読めませんでした")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "選んだ地点の詳しく" })).toHaveTextContent("総合難易度");
  });
});
