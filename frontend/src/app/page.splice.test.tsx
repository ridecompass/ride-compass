/**
 * `app/page.tsx`——トップページのうち、「ルート結果」で候補の区間を乗り換えて新しいルートを作る編集と地図の受け渡し。
 *
 * 見ること: 編集の間は地図で地点も区間も扱わず全部の候補を重ね、「ルート結果」の見出しに候補1本への操作を出さず、
 * 作り直すと編集が終わること、乗り換えの帯を押すと帯だけを選ぶこと、作り直しの失敗を窓で知らせること、
 * 合成ルートを選んでいる間は元のルートだけを重ねること。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DESTINATION,
  ELSEWHERE,
  HERE,
  type User,
  clickMap,
  clickSegment,
  generate,
  linesOn,
  marksAt,
  renderHome,
  route,
  routeLinesOnMap,
  selectDestination,
  selectedSectionOnMap,
  serveHome,
  serveRoadsAt,
} from "@/testing/homePage";
import { mapOnScreen } from "@/testing/maplibre";
import { makeGenerationConditions, routeThrough, type Places } from "@/testing/routeFixtures";
import type { RouteCandidate } from "@/types/route";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

describe("区間の乗り換え", () => {
  // 地点（[経度, 緯度]）。元の候補は P0→P1→P2→P3→P4 を進み、もう1本は P1 と P2 の間を Q、P3 と P4 の間を R を通って進む
  // （片方の分かれ道だけを乗り換えると、どちらの候補とも違う道になる）。
  const PLACES: Places = {
    P0: [139.7, 35.6],
    P1: [139.71, 35.6],
    P2: [139.72, 35.6],
    P3: [139.73, 35.6],
    P4: [139.74, 35.6],
    Q: [139.715, 35.61],
    R: [139.735, 35.61],
  };

  function through(id: string, names: string[], overrides: Partial<RouteCandidate> = {}) {
    return route(id, { kind: "destination", ...routeThrough(PLACES, names), ...overrides });
  }

  const BASE = through("base", ["P0", "P1", "P2", "P3", "P4"], { estimated_duration_seconds: 1800 });
  const OTHER = through("other", ["P0", "P1", "Q", "P2", "P3", "R", "P4"], { estimated_duration_seconds: 2400 });
  const DESTINATION_CONDITIONS = makeGenerationConditions({
    latitude: HERE.latitude,
    longitude: HERE.longitude,
    destination: DESTINATION,
  });

  /** 目的地を置いて2本の候補を作る。 */
  async function generateTwo(user: User) {
    await selectDestination(user);
    clickMap(DESTINATION);
    jobs.respond([BASE, OTHER], DESTINATION_CONDITIONS);
    await generate(user);
  }

  /** 先頭の候補で編集を始める。 */
  async function startEditing(user: User) {
    await user.click(await screen.findByRole("button", { name: "ルートを合成" }));
    await waitFor(() => expect(mapOnScreen().sourceFeatures("route-splice-bands").length).toBeGreaterThan(0));
  }

  it("編集している間は地図で地点も区間も扱わず、全部の候補を重ね、見出しに候補1本への操作を出さない。作り直すと編集が終わる", async () => {
    const { user } = renderHome();
    await generateTwo(user);
    await startEditing(user);
    expect(screen.queryByRole("button", { name: "GPX出力" })).toBeNull();
    expect(routeLinesOnMap()).toHaveLength(2);
    expect(routeLinesOnMap()).toEqual(expect.arrayContaining([BASE.geometry.coordinates, OTHER.geometry.coordinates]));
    clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toEqual([]);
    expect(marksAt(DESTINATION)).toEqual([expect.objectContaining({ draggable: false })]);

    clickSegment(mapOnScreen().sourceFeatures("route-segments")[0], ELSEWHERE);
    await user.click(screen.getByRole("button", { name: "編集をやめて候補へ戻る" }));
    expect(selectedSectionOnMap()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "ルートを合成" }));
    jobs.respond([BASE, OTHER], DESTINATION_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(mapOnScreen().sourceFeatures("route-splice-bands")).toEqual([]));
  });

  it("乗り換えの帯が区間と道に重なった所を押すと、帯の乗り換えだけを選び、区間も道も開かない", async () => {
    serveRoadsAt([{ at: HERE, properties: { osm_way_id: 1, feature_key: "1" } }]);
    const { user } = renderHome();
    await generateTwo(user);
    await startEditing(user);
    const [band] = mapOnScreen().sourceFeatures("route-splice-bands");
    const [segment] = mapOnScreen().sourceFeatures("route-segments");
    // 一番上に描かれた地物から並べる（帯は区間の上に重ねて描く）。
    clickMap(HERE, [
      { layer: "route-splice-bands-spliceBandHit", properties: band.properties ?? {}, geometry: band.geometry },
      { layer: "route-segments-detailHit", properties: segment.properties ?? {}, geometry: segment.geometry },
    ]);

    expect(await screen.findByRole("button", { name: "1つ戻す" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "この道の評価を見る" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "編集をやめて候補へ戻る" }));
    expect(selectedSectionOnMap()).toEqual([]);
  });

  it("作り直しの失敗は前の候補を残して窓で知らせ、作った合成ルートを選んでいる間は、地図に元のルートだけを重ねる", async () => {
    const { user } = renderHome();
    await generateTwo(user);
    jobs.fail("混雑しています");
    await generate(user);
    const notice = await screen.findByRole("dialog", { name: "作り直せませんでした" });
    expect(notice).toHaveAccessibleDescription("混雑しています");
    await user.click(within(notice).getByRole("button", { name: "閉じる" }));
    expect(routeLinesOnMap()).toHaveLength(2);
    await startEditing(user);
    const [band] = mapOnScreen().sourceFeatures("route-splice-bands");
    clickMap(HERE, [
      { layer: "route-splice-bands-spliceBandHit", properties: band.properties ?? {}, geometry: band.geometry },
    ]);
    jobs.respond(
      [route("evaluated", { edge_ids: ["P0-P1", "P1-Q", "Q-P2", "P2-P3", "P3-P4"] })],
      DESTINATION_CONDITIONS,
    );
    await user.click(await screen.findByRole("button", { name: "新しいルートを作成" }));

    await waitFor(() => expect(routeLinesOnMap()).toHaveLength(2));
    const [created] = linesOn("route-selected");
    expect(routeLinesOnMap()).toEqual(expect.arrayContaining([BASE.geometry.coordinates, created]));
    expect(created).not.toEqual(BASE.geometry.coordinates);
    expect(created).not.toEqual(OTHER.geometry.coordinates);
  });
});
