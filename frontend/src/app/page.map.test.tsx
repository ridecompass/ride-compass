/**
 * `app/page.tsx`——トップページのうち、地図を押したときに起きること。
 *
 * 見ること: 地図を押したときの意味は効いているパネルで決まり（「ルート設定」の条件タブは選んでいる地点を置く、
 * 「ルート結果」は候補の線でそのルートを選び区間でその中身を出す、閉じている間は押した物の中身を小窓に出すだけ）、PC で
 * 2つの区分を開いていれば最後に触った区分が効いてその題に添えること、区間を選んでいる間は地図にその区間の範囲の縁取りと
 * 選んだ地点の印が出ること、効いているパネルが移ると前のパネルで地図に出した選択を外すこと。区間を押すと、その区間の近くの施設を
 * 引いて種類ごとに出すこと。
 *
 * ここで見ないもの: 地図に置く地点（ピン・名前のある点・目的地・保存した地点）は`app/page.places.test.tsx`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { screen, waitFor, within } from "@testing-library/react";
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
} from "@/testing/homePage";
import { heldReplies, onBackend } from "@/testing/backendServer";
import { mapOnScreen } from "@/testing/maplibre";
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

describe("区間の近くの施設", () => {
  // 東へ1kmずつ進む区間2つのルート。
  const NEAR = route("near", {
    ...routeThrough({ a: [139.7, 35.7], b: [139.71, 35.7], c: [139.72, 35.7] }, ["a", "b", "c"], [1, 1]),
    distance_km: 2,
  });

  async function pressSecondSegment(user: Parameters<typeof generate>[0]) {
    jobs.respond([NEAR], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const [, second] = mapOnScreen().sourceFeatures("route-segments");
    clickSegment(second, HERE);
    return screen.getByRole("group", { name: "近くの施設" });
  }

  it("区間を押すとその区間の近くの施設を引き、引いている間は読み込み中と出し、届くと種類ごとの件数のチップを出して、押すとその種類を名前（無ければ種別）・道からの距離・何km地点で道のりの順に開く", async () => {
    const { user } = renderHome();
    const held = heldReplies();
    onBackend("POST", "/api/routes/side-points", held.reply);

    const nearby = await pressSecondSegment(user);
    expect(within(nearby).getByText("読み込み中")).toBeInTheDocument();

    await held.answer(
      0,
      Response.json({
        points: [
          {
            distance_km: 1.3,
            offset_m: 12,
            layer: "supply_poi",
            properties: { kind: "convenience", name: "ローソン 渋谷店" },
          },
          {
            distance_km: 1.6,
            offset_m: 30,
            layer: "accident_point",
            properties: { involves_bicycle: true, fatal: true },
          },
          { distance_km: 1.8, offset_m: 5, layer: "supply_poi", properties: { kind: "toilets" } },
        ],
      }),
    );
    const supply = await within(nearby).findByRole("button", { name: "補給・休憩ポイント 2" });
    expect(within(nearby).queryByText("読み込み中")).toBeNull();

    await user.click(supply);
    expect(supply).toHaveAttribute("aria-expanded", "true");
    expect(
      within(within(nearby).getByRole("list", { name: "補給・休憩ポイント" }))
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["ローソン 渋谷店道から12m1.3km地点", "トイレ道から5m1.8km地点"]);

    await user.click(within(nearby).getByRole("button", { name: "事故[警察庁統計] 1" }));
    expect(within(nearby).getByRole("list", { name: "事故[警察庁統計]" })).toHaveTextContent(
      "自転車関連 ・ 死亡事故道から30m1.6km地点",
    );
  });

  it("引けなかったら、区間の評価はそのまま出し、近くの施設を読めなかったと出す", async () => {
    const { user } = renderHome();
    onBackend("POST", "/api/routes/side-points", () => Response.json({ detail: "失敗" }, { status: 500 }));

    const nearby = await pressSecondSegment(user);

    expect(await within(nearby).findByText("近くの施設を読めませんでした")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "選んだ地点の詳しく" })).toHaveTextContent("総合難易度");
  });
});
