/**
 * `app/page.tsx`——トップページのうち、地図を押したときに起きること。
 *
 * 見ること: 地図を押したときの意味は効いているパネルで決まり（「ルート設定」の条件タブは選んでいる地点を置く、
 * 「ルート結果」は候補の線でそのルートを選び区間でその中身を出す、閉じている間は押した物の中身を小窓に出すだけ）、PC で
 * 2つの区分を開いていれば最後に触った区分が効いてその題に添えること、区間を選んでいる間は地図にその区間の範囲の縁取りと
 * 選んだ地点の印が出ること、効いているパネルが移ると前のパネルで地図に出した選択を外すこと。
 *
 * ここで見ないもの: 地図に置く地点（ピン・名前のある点・目的地・保存した地点）は`app/page.places.test.tsx`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { screen, waitFor } from "@testing-library/react";
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
import { mapOnScreen } from "@/testing/maplibre";
import { makeGenerationConditions, makeRouteSegment } from "@/testing/routeFixtures";
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
