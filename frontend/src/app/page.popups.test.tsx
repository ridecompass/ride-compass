/**
 * `app/page.tsx`——トップページのうち、地図の小窓。
 *
 * 見ること: 「ルート結果」を開いていても、区間・道・地図の点のどれを押しても小窓は1つだけで、最後に押した物の中身を出すこと。
 * 点・区間はタップで開き、道はタップでは開かず、長押し（ここでは同じに受けるマウスの右ボタン）で、点の上でも、道の層を出していなくても押した所に近い
 * 道（backend の答え）を開き、道のタイルを読まずにその道の線を強調すること。
 * 名前の無い点も押すと種類の名前で並べ、重なった点と、束ねた代表点の中の点（名前の無い残りは数）は全部並べること。区間の中身から点を開くと区間へ戻れ、道へ
 * 入れ替えると区間の選びを外し、開ける物の無い所を押すと閉じること。区間の小窓が上の帯と負担の内訳の形で出て、寄せるアイコンで寄せること。押せる物のタップは待たずに開き、
 * 何も無い所を続けて2回押しても閉じないこと。
 *
 * ここで見ないもの: ルートの近くの点の小窓（区間へ戻る）は`app/page.routePoints.test.tsx`が、地図を押したときの
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
import { onBackend, serveClientConfig, serveCostAxisCatalog } from "@/testing/backendServer";
import { AVOIDANCE_LEVELS, avoidanceRow, clientConfigResponse, roadClassCatalog } from "@/testing/clientConfig";
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
  route,
  selectedSectionOnMap,
  serveHome,
  serveRoadsAt,
} from "@/testing/homePage";
import { mapOnScreen, type PointedFeature } from "@/testing/maplibre";
import { inspectorResult } from "@/testing/roadInspector";
import { makeRouteSegment } from "@/testing/routeFixtures";
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

  it("区間の小窓は、上の帯に到達予想、その下に分へ丸めて1分以上の軸の負担だけを出し、押しただけでは地図は動かず、寄せるアイコンで区間へ寄せる", async () => {
    serveCostAxisCatalog();
    const segment = makeRouteSegment({
      estimated_arrival_time: "2026-10-05T00:30:00Z",
      penalty: {
        axis_seconds: { ascent: 120, vibration: 29 },
        preferred_seconds: 0,
        avoided_seconds: 0,
        turn_penalty_seconds: 0,
        total_seconds: 149,
      },
    });
    const { user } = renderHome();
    // 2つ目の区間は、どの軸も分へ丸めると1分に満たない。
    const slight = makeRouteSegment({
      penalty: {
        axis_seconds: { ascent: 29, vibration: 29 },
        preferred_seconds: 0,
        avoided_seconds: 0,
        turn_penalty_seconds: 0,
        total_seconds: 58,
      },
    });
    jobs.respond([route("one", { segments: [segment, slight] })], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));

    const fitsBefore = mapOnScreen().fits().length;
    clickSegment(mapOnScreen().sourceFeatures("route-segments")[1], HERE);
    expect(await screen.findByRole("group", { name: "区間の小窓の上の帯" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "負担の内訳" })).toBeNull();

    clickSegment(mapOnScreen().sourceFeatures("route-segments")[0], HERE);

    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toHaveTextContent("到達予想 09:30着");
    // 軸は絵で出し、名前は読み上げに残す。分へ丸めて1分に満たない軸と合計は出さない。
    expect(screen.getByRole("group", { name: "負担の内訳" })).toHaveTextContent(/^登坂\+2分$/);

    expect(mapOnScreen().fits()).toHaveLength(fitsBefore);
    await user.click(screen.getByRole("button", { name: "地図をここへ寄せる" }));
    await waitFor(() => expect(mapOnScreen().fits()).toHaveLength(fitsBefore + 1));
  });

  it("ルートの脇の線のある区間の小窓は、避け方の倍率を決めた道ごとに、線と同じ印で道の名前と分に丸めて1分以上の増えた・減った分、まとまり・長さ・段を出す", async () => {
    serveClientConfig(
      clientConfigResponse({
        road_classes: roadClassCatalog({
          avoidance: {
            levels: AVOIDANCE_LEVELS,
            sections: [{ key: "highway", label: "道路の種類" }],
            rows: [
              avoidanceRow("highway.secondary", "highway", { label: "一般県道" }),
              avoidanceRow("highway.primary", "highway", { label: "主要地方道" }),
              avoidanceRow("highway.cycleway", "highway", { label: "自転車の道" }),
            ],
          },
        }),
      }),
    );
    const segment = makeRouteSegment({
      avoidance_stretches: [
        { row_key: "highway.primary", level: "slight_avoid", distance_km: 0.3, seconds: 60 },
        { row_key: "highway.cycleway", level: "slight_prefer", distance_km: 0.1, seconds: -29 },
      ],
      penalty: {
        axis_seconds: {},
        preferred_seconds: -29,
        avoided_seconds: 60,
        turn_penalty_seconds: 0,
        total_seconds: 31,
      },
    });
    const { user } = renderHome();
    jobs.respond([route("one", { segments: [segment] })], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));

    clickSegment(mapOnScreen().sourceFeatures("route-segments")[0], HERE);

    // 行・まとまり・段の名前は道路タブと同じ画面の設定から引き、並びは応答のまま。
    expect(await screen.findByRole("list", { name: "ルートの脇の線の理由" })).toHaveTextContent(
      /^主要地方道\+1分道路の種類・300m・×1\.4自転車の道好んだ道道路の種類・100m・×0\.7$/,
    );
  });
});
