/**
 * `app/page.tsx`——トップページのうち、地図を押したときに起きること。
 *
 * 見ること: 地図を押したときの意味は効いているパネルで決まり（「ルート設定」の条件タブは選んでいる地点を置く、
 * 「ルート結果」は候補の線でそのルートを選び区間でその中身を出す、閉じている間は押した物の中身を小窓に出すだけ）、PC で
 * 2つの区分を開いていれば最後に触った区分が効いてその題に添えること、ピンを押しても消えずルート設定ではその地点を選ぶこと、
 * 目的地の行で探して置いた地点と、名前のある点を押して置いた地点が地図に立ち、行にその名前が出ること、
 * 名前を付けて保存した地点を打つ欄から選び直せ、「保存済み」の「地点」から呼び出すと条件タブへ移って置くこと。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POINT_TILE_SOURCES } from "@/features/map/scene/groups/points";
import { sceneLayerId } from "@/features/map/scene/sceneBuilders";
import { onBackend } from "@/testing/backendServer";
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
  section,
  selectDestination,
  serveHome,
} from "@/testing/homePage";
import { mapOnScreen, type PointedFeature } from "@/testing/maplibre";
import { makeGenerationConditions } from "@/testing/routeFixtures";
import type { Coordinates } from "@/types/route";

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

  it("ピンを押しただけでは消えず、ルート設定ではその地点を選んで詳しくを出し、閉じている間は呼び名と名前を小窓に出す", async () => {
    const { user } = renderHome();
    await selectDestination(user);
    clickMap(DESTINATION);
    await user.click(screen.getByRole("button", { name: "出発地: 現在地" }));

    const [destinationPin] = marksAt(DESTINATION);
    await user.click(destinationPin.element);
    expect(marksAt(DESTINATION)).toHaveLength(1);
    expect(screen.getByRole("region", { name: "目的地" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    await user.click(destinationPin.element);
    expect(marksAt(DESTINATION)).toHaveLength(1);
    expect(screen.getByText("目的地: 地図で選んだ地点")).toBeInTheDocument();
  });

  it("名前のある点を押すと、選んでいる地点をその点へその名前で置き、地図と地点の並びに出す。閉じている間は置かない", async () => {
    const shop: Coordinates = { latitude: 35.71, longitude: 139.71 };
    const pointed = [
      {
        layer: sceneLayerId(POINT_TILE_SOURCES.poi.sourceId, "supply_poi"),
        properties: { name: "角の店", kind: "convenience" },
        geometry: { type: "Point", coordinates: [shop.longitude, shop.latitude] },
      } satisfies PointedFeature,
    ];
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("checkbox", { name: "補給・休憩ポイント" }));
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "経由地を足す" }));
    // 押した所は絵の端でも、点そのものの位置へ置く。
    clickMap(ELSEWHERE, pointed);
    expect(marksAt(shop)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "経由地1: 角の店" })).toBeInTheDocument();

    await selectDestination(user);
    clickMap(shop, pointed);
    expect(marksAt(shop)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "目的地: 角の店" })).toBeInTheDocument();
    // 地図の印は役割の名前で見分けられ、地点の並びの印と同じ記号を描く。
    const [waypointMark, destinationMark] = marksAt(shop).map(({ element }) => element);
    expect(waypointMark).toHaveAccessibleName("経由地 1");
    expect(destinationMark).toHaveAccessibleName("目的地");
    expect(screen.getByRole("img", { name: "出発地" })).toBeInTheDocument();
    const listedDestination = screen.getByRole("button", { name: "目的地: 角の店" }).querySelector("svg");
    // 大きさは置き場ごとに違うので、記号の中身で比べる。
    expect(listedDestination?.innerHTML).toBeTruthy();
    expect(destinationMark.querySelector("svg")?.innerHTML).toBe(listedDestination?.innerHTML);

    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    clickMap(ELSEWHERE, pointed);
    expect(marksAt(shop)).toHaveLength(2);
  });

  it("目的地を探して選んだ地点は地図に目的地として立ち、地点の並びにその名前が出る", async () => {
    const candidate = {
      kind: "facility",
      level: "point",
      name: "浅草寺",
      area: "台東区浅草二丁目",
      latitude: 35.7148,
      longitude: 139.7967,
    } as const;
    onBackend("GET", "/api/place-search", () => Response.json({ candidates: [candidate] }));
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "目的地: 未設定" }));
    const searchBox = screen.getByRole("searchbox", { name: "目的地を住所・施設で探す" });

    await user.type(searchBox, "浅草寺{Enter}");
    await user.click(await screen.findByRole("button", { name: new RegExp(candidate.name) }));

    expect(marksAt(candidate)).toHaveLength(1);
    expect(screen.getByRole("button", { name: `目的地: ${candidate.name}` })).toBeInTheDocument();
  });

  it("名前を付けて保存した地点は、目的地を消したあとも打つ欄を押して選び直せ、「保存済み」の「地点」から呼び出すと条件タブへ移って置く", async () => {
    const { user } = renderHome();
    await selectDestination(user);
    clickMap(DESTINATION);
    await user.click(screen.getByRole("button", { name: "地点を保存" }));
    const dialog = screen.getByRole("dialog", { name: "地点を保存" });
    const nameInput = within(dialog).getByRole("textbox", { name: "保存する地点の名前" });
    await user.clear(nameInput);
    await user.type(nameInput, "いつものカフェ");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await user.click(screen.getByRole("button", { name: "目的地を消す" }));
    expect(marksAt(DESTINATION)).toEqual([]);

    await user.click(screen.getByRole("searchbox", { name: "目的地を住所・施設で探す" }));
    const saved = screen.getByRole("list", { name: "保存した地点" });
    await user.click(within(saved).getByRole("button", { name: /いつものカフェ/ }));

    expect(marksAt(DESTINATION)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "目的地: いつものカフェ" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "保存済み" }));
    await user.click(screen.getByRole("tab", { name: "地点" }));
    await user.click(screen.getByRole("button", { name: "「いつものカフェ」を呼び出す" }));
    const menu = screen.getByRole("dialog", { name: "「いつものカフェ」をどこに置くか" });
    await user.click(within(menu).getByRole("button", { name: "経由地に足す" }));

    expect(screen.getByRole("tab", { name: "条件" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "経由地1" })).toHaveTextContent("いつものカフェ");
    expect(marksAt(DESTINATION)).toHaveLength(2);
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
