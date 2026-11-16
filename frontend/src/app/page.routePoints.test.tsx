/**
 * `app/page.tsx`——トップページのうち、ルートを選んでいる間に地図へ描く点（「表示」で出した点の層）と、その点の小窓。
 *
 * 見ること: ルートを選んでいる間は「表示」で出した点の層をルートの線から近い点だけに描き（区間を選んでも変えず、「範囲と色」で
 * 地図全体を選ぶと地図全体へ戻す）、描いた名前のある点を押すと道からの距離を添えた点の小窓を出して区間へ戻れ、名前の無い点を
 * 押すと種類の名前で点の小窓を開くこと。走行中は点の小窓の位置を現在地からの残りで出し、同じ道を2度通るルートでは現在地から
 * 続く側で数えること。
 *
 * ここで見ないもの: 地図を押したときの意味と、ルートを収めることは`app/page.map.test.tsx`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POINT_TILE_SOURCES } from "@/features/map/scene/groups/points";
import { sceneLayerId } from "@/features/map/scene/sceneBuilders";
import {
  ELSEWHERE,
  HERE,
  LOOP_CONDITIONS,
  candidateTabs,
  clickMap,
  clickSegment,
  generate,
  renderHome,
  route,
  serveHome,
} from "@/testing/homePage";
import { onBackend } from "@/testing/backendServer";
import { installGeolocation } from "@/testing/geolocation";
import { mapOnScreen, type PointedFeature } from "@/testing/maplibre";
import { routeThrough } from "@/testing/routeFixtures";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
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

  it("ルートを選んでいる間は、「表示」で出した点の層をルート全体の近くだけに描き、区間を選んでも変えず、「範囲と色」で地図全体を選ぶと地図全体へ戻す", async () => {
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

    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("tab", { name: "範囲と色" }));
    await user.click(screen.getByRole("radio", { name: "地図全体" }));
    await user.keyboard("{Escape}");
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

  it("描いた名前のある点を押すと、道からの距離を添えた点の小窓を出して区間へ戻れ、名前の無い点を押すと種類の名前で点の小窓を開く", async () => {
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

    clickMap(ELSEWHERE, [drawn(undefined)]);
    const popup = screen.getByRole("group", { name: "点の小窓の上の帯" }).parentElement!;
    expect(within(popup).getByText("トイレ")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ここのストリートビューを開く" })).toBeInTheDocument();
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
