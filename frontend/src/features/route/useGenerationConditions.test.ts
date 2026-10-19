/**
 * 生成の条件（`useGenerationConditions.ts`）——周回か・全長の目標を決めるか・距離・候補数・地点（出発地以外）・重み・道ごとの避け方と、地図の
 * タップで置く地点の選び（経由地は足すか、何番目を置き直すか）と、周回の間に覚えておく目的地と、検索・名前のある点で置いた地点の候補（その位置のままの間だけ）を返す。保存する値（地点以外）は開き直しても残り、読むときに今の画面が受け付ける範囲・
 * 今の項目へ揃える。重みは軸カタログの公開軸へ揃えた値を返し、送るのは上書きを有効にしてカタログが届いた後だけ。
 *
 * ここで見ないもの:
 * - 重みの揃え方の細部（増えた軸を既定の重みで補う・消えた軸を外す・取得が決まるまで揃えない） →
 *   `routePreferenceSync.test.ts`。ここでは揃えた値を返すことを1件ずつ見る
 * - 重みを送るかの判断（上書きしていない・カタログが届かない間は送らない） → `routePreferenceSync.test.ts`。
 *   ここでは開き直した後に送る重みを1件見る
 * - 保存の読み書きそのもの（読めない・書けない端末で既定値になる） → `hooks/useStoredState.test.ts`
 * - 地図で置いた出発地を位置の持ち主が受け取ったあと → `hooks/useLocation.test.ts`
 * - 地図のタップが選んだ地点を置く場面（「ルート設定」の「条件」タブが効いている間だけ） → `app/page.test.tsx`
 * - 条件を生成へ送る形 → `useRouteGeneration.test.ts`
 *
 * 差し替えたもの: 軸カタログの応答（網の層）。保存はテスト環境の`localStorage`を
 * 本物のまま使い、開き直しは同じ保存の上でフックを描き直して作る。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AVOIDABLE_ROWS, AVOIDANCE_LEVELS, DEFAULT_ROAD_AVOIDANCE } from "@/features/route/roadAvoidance";
import { heldReplies, onBackend, serveAxisCatalog } from "@/testing/backendServer";
import { catalogEntry, catalogResponse, TWO_AXIS_CATALOG } from "@/testing/catalogAxes";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import type { Coordinates, PlaceCandidate } from "@/types/route";

import { useGenerationConditions } from "./useGenerationConditions";

const A: Coordinates = { latitude: 35.1, longitude: 139.1 };
const B: Coordinates = { latitude: 35.2, longitude: 139.2 };
const C: Coordinates = { latitude: 35.3, longitude: 139.3 };

function renderConditions() {
  const onOriginPlace = vi.fn();
  const rendered = renderHook(() => useGenerationConditions({ onOriginPlace }));
  return { ...rendered, onOriginPlace };
}

/** 同じ保存の上で開き直す。 */
function reopen(rendered: { unmount: () => void }) {
  rendered.unmount();
  return renderConditions();
}

/** 地点`at`で当たった施設の候補。 */
function candidateAt(at: Coordinates, name: string): PlaceCandidate {
  return { kind: "facility", level: "point", name, area: null, ...at };
}

function point(index: number): Coordinates {
  return { latitude: 35 + index / 100, longitude: 139 };
}

beforeEach(() => {
  window.localStorage.clear();
  // 既定は届かないまま（重みを見るテストだけが届ける）。
  onBackend("GET", "/api/axis-catalog", heldReplies().reply);
});

describe("全長の目標", () => {
  it("既定は決める形で、外したことは開き直しても残る", () => {
    const first = renderConditions();
    expect(first.result.current.distanceTargeted).toBe(true);

    act(() => first.result.current.setDistanceTargeted(false));

    expect(reopen(first).result.current.distanceTargeted).toBe(false);
  });
});

describe("周回", () => {
  it("既定は周回で、外したことは開き直しても残る", () => {
    const first = renderConditions();
    expect(first.result.current.loop).toBe(true);

    act(() => first.result.current.setLoop(false));

    expect(reopen(first).result.current.loop).toBe(false);
  });

  it("周回にしても置いた目的地を覚えておき、周回の間は返さず選べず（地図で置くと出発地）、外すと戻す", () => {
    const { result, onOriginPlace } = renderConditions();
    act(() => result.current.setLoop(false));
    act(() => result.current.selectPoint({ role: "destination" }));
    act(() => result.current.placeAtSelected(A, null));

    act(() => result.current.setLoop(true));
    expect(result.current.destination).toBeNull();
    expect(result.current.selectedPoint).toEqual({ role: "origin" });
    act(() => result.current.placeAtSelected(B, null));
    expect(onOriginPlace).toHaveBeenCalledExactlyOnceWith(B);

    act(() => result.current.setLoop(false));
    expect(result.current.destination).toEqual(A);
  });

  it("周回の間に経由地と目的地を一度に消すと、経由地だけを消して覚えている目的地は残す", () => {
    const { result } = renderConditions();
    act(() => result.current.setLoop(false));
    act(() => result.current.setDestination(A));
    act(() => result.current.setLoop(true));
    act(() => result.current.selectPoint({ role: "waypoint", index: null }));
    act(() => result.current.placeAtSelected(B, null));

    act(() => result.current.clearPoints());
    act(() => result.current.setLoop(false));

    expect(result.current.waypoints).toEqual([]);
    expect(result.current.destination).toEqual(A);
  });
});

describe("地点", () => {
  // 目的地を置くのは周回を外した間（周回の間の目的地は上の「周回」）。
  beforeEach(() => window.localStorage.setItem("ridecompass:loop", "false"));

  it("何も選んでいなければ出発地を選んでいて、地図で置くと位置の持ち主へ渡す。自分では持たない", () => {
    const { result, onOriginPlace } = renderConditions();
    expect(result.current.selectedPoint).toEqual({ role: "origin" });

    act(() => result.current.placeAtSelected(A, null));

    expect(onOriginPlace).toHaveBeenCalledWith(A);
    expect(result.current.destination).toBeNull();
    expect(result.current.waypoints).toEqual([]);
  });

  it("選んだ地点を置き、選んだままにする（続けて置くとその地点を置き直す）", () => {
    const { result } = renderConditions();
    act(() => result.current.selectPoint({ role: "destination" }));

    act(() => result.current.placeAtSelected(A, null));
    act(() => result.current.placeAtSelected(B, null));

    expect(result.current.destination).toEqual(B);
    expect(result.current.selectedPoint).toEqual({ role: "destination" });
  });

  it("新しい経由地を選ぶと置くたびに足し、生成が受け付ける数に達したらそれ以上は足さない", () => {
    const max = routeGenerateConfig.max_waypoints;
    const { result } = renderConditions();
    act(() => result.current.selectPoint({ role: "waypoint", index: null }));

    for (let i = 0; i <= max; i++) act(() => result.current.placeAtSelected(point(i), null));

    expect(result.current.waypoints).toEqual([...Array(max).keys()].map(point));
  });

  it("番号を指した経由地を選ぶと、その経由地を置き直す", () => {
    const { result } = renderConditions();
    act(() => result.current.selectPoint({ role: "waypoint", index: null }));
    act(() => result.current.placeAtSelected(A, null));
    act(() => result.current.placeAtSelected(B, null));

    act(() => result.current.selectPoint({ role: "waypoint", index: 0 }));
    act(() => result.current.placeAtSelected(C, null));

    expect(result.current.waypoints).toEqual([C, B]);
  });

  it("店など名前のある点に置くと、その点の候補として置く（名前はその位置のままの間だけ返す）", () => {
    const { result } = renderConditions();
    const shop = candidateAt(C, "着く店");
    act(() => result.current.selectPoint({ role: "destination" }));

    act(() => result.current.placeAtSelected(C, shop));
    expect(result.current.destination).toEqual(C);
    expect(result.current.foundAt(result.current.destination)).toEqual(shop);

    act(() => result.current.placeAtSelected(point(0), null));
    expect(result.current.foundAt(result.current.destination)).toBeNull();
  });

  it("選んだ経由地が消えたら、出発地を選んでいることに戻る", () => {
    const { result } = renderConditions();
    act(() => result.current.selectPoint({ role: "waypoint", index: null }));
    act(() => result.current.placeAtSelected(A, null));
    act(() => result.current.placeAtSelected(B, null));
    act(() => result.current.selectPoint({ role: "waypoint", index: 1 }));

    act(() => result.current.removeWaypoint(1));

    expect(result.current.selectedPoint).toEqual({ role: "origin" });
  });

  it("経由地は位置を指して動かす・消せ、目的地も消せる", () => {
    const { result } = renderConditions();
    act(() => result.current.selectPoint({ role: "waypoint", index: null }));
    act(() => result.current.placeAtSelected(A, null));
    act(() => result.current.placeAtSelected(B, null));
    act(() => result.current.setDestination(A));

    act(() => result.current.moveWaypoint(1, C));
    expect(result.current.waypoints).toEqual([A, C]);

    act(() => result.current.removeWaypoint(0));
    act(() => result.current.clearDestination());
    expect(result.current.waypoints).toEqual([C]);
    expect(result.current.destination).toBeNull();
  });

  it("経由地と目的地は一度に消せ、出発地はそのまま残し、出発地を選んでいることに戻る", () => {
    const { result, onOriginPlace } = renderConditions();
    act(() => result.current.selectPoint({ role: "waypoint", index: null }));
    act(() => result.current.placeAtSelected(A, null));
    act(() => result.current.placeAtSelected(B, null));
    act(() => result.current.setDestination(C));

    act(() => result.current.clearPoints());

    expect(result.current.waypoints).toEqual([]);
    expect(result.current.destination).toBeNull();
    expect(result.current.selectedPoint).toEqual({ role: "origin" });
    expect(onOriginPlace).not.toHaveBeenCalled();
  });

  it("検索で選んだ地点はその役割で置く（経由地は番号を指せばそれを置き直し、指さなければ足してその経由地を選ぶ）", () => {
    const { result, onOriginPlace } = renderConditions();
    const originShop = candidateAt(A, "出発の店");
    act(() => result.current.placeFound("origin", originShop, null));
    expect(onOriginPlace).toHaveBeenCalledWith(A);
    expect(result.current.foundAt({ ...A })).toEqual(originShop);

    act(() => result.current.selectPoint({ role: "waypoint", index: null }));
    act(() => result.current.placeFound("waypoint", candidateAt(B, "寄る店"), null));
    expect(result.current.waypoints).toEqual([B]);
    expect(result.current.selectedPoint).toEqual({ role: "waypoint", index: 0 });

    act(() => result.current.placeFound("destination", candidateAt(C, "着く店"), null));
    expect(result.current.destination).toEqual(C);

    act(() => result.current.placeFound("waypoint", candidateAt(A, "寄り直す店"), 0));
    expect(result.current.waypoints).toEqual([A]);
  });

  it("地点は保存せず、開き直すと置いていない状態から始まる", () => {
    const first = renderConditions();
    act(() => first.result.current.selectPoint({ role: "waypoint", index: null }));
    act(() => first.result.current.placeAtSelected(A, null));
    act(() => first.result.current.setDestination(B));

    const { result } = reopen(first);

    expect(result.current.waypoints).toEqual([]);
    expect(result.current.destination).toBeNull();
  });
});

describe("距離と候補数", () => {
  it("入力した値は文字列のまま持ち、開き直しても残る", () => {
    const first = renderConditions();
    act(() => first.result.current.setDistanceInput("55"));
    act(() => first.result.current.setMaxRoutesInput("3"));

    const { result } = reopen(first);

    expect(result.current.distanceInput).toBe("55");
    expect(result.current.maxRoutesInput).toBe("3");
  });

  it.each([
    { label: "5km刻みの値", saved: "45", read: "45" },
    {
      label: "上限ちょうど",
      saved: String(routeGenerateConfig.max_distance_km),
      read: String(routeGenerateConfig.max_distance_km),
    },
    { label: "1km刻みだった頃の値は近い方の刻みへ（下へ）", saved: "37", read: "35" },
    { label: "1km刻みだった頃の値は近い方の刻みへ（上へ）", saved: "38", read: "40" },
    { label: "最初の刻みより短い", saved: "1", read: "5" },
    { label: "0km", saved: "0", read: "30" },
    { label: "上限より長い", saved: String(routeGenerateConfig.max_distance_km + 1), read: "30" },
    { label: "数でない", saved: "abc", read: "30" },
  ])("距離の保存値は、範囲の中なら5km刻みへ寄せて受け入れ、外なら既定の30kmにする（$label）", ({ saved, read }) => {
    window.localStorage.setItem("ridecompass:distance-km", saved);

    expect(renderConditions().result.current.distanceInput).toBe(read);
  });

  it.each([
    { label: "1件ちょうど", saved: "1", accepted: true },
    { label: "上限ちょうど", saved: String(routeGenerateConfig.max_routes), accepted: true },
    { label: "0件", saved: "0", accepted: false },
    { label: "上限より多い", saved: String(routeGenerateConfig.max_routes + 1), accepted: false },
    { label: "整数でない", saved: "2.5", accepted: false },
  ])("候補数の保存値は範囲の中の整数だけを受け入れる（$label）", ({ saved, accepted }) => {
    window.localStorage.setItem("ridecompass:max-routes", saved);

    expect(renderConditions().result.current.maxRoutesInput).toBe(
      accepted ? saved : String(routeGenerateConfig.default_max_routes),
    );
  });
});

describe("重み", () => {
  it("揃えても保存した重みは書き換えず、公開を取り下げた軸が戻ればその重みも戻る", async () => {
    window.localStorage.setItem("ridecompass:weight-override-enabled", "true");
    window.localStorage.setItem("ridecompass:route-preference", JSON.stringify({ axis_a: 0.7, axis_c: 0.2 }));
    serveAxisCatalog(TWO_AXIS_CATALOG);
    const first = renderConditions();
    await waitFor(() => expect(first.result.current.routePreference).toEqual({ axis_a: 0.7, axis_b: 0.6 }));

    serveAxisCatalog(
      catalogResponse([
        catalogEntry({ axis_id: "axis_a", default_weight: 0.4 }),
        catalogEntry({ axis_id: "axis_c", default_weight: 0.6 }),
      ]),
    );
    const { result } = reopen(first);

    await waitFor(() => expect(result.current.routePreference).toEqual({ axis_a: 0.7, axis_c: 0.2 }));
  });

  it("上書きは既定で無効で、動かした重みと上書きの有効は開き直しても残る", async () => {
    serveAxisCatalog(TWO_AXIS_CATALOG);
    const first = renderConditions();
    expect(first.result.current.weightOverrideEnabled).toBe(false);
    act(() => first.result.current.setRoutePreference({ axis_a: 0.7, axis_b: 0.3 }));
    act(() => first.result.current.setWeightOverrideEnabled(true));

    const { result } = reopen(first);

    await waitFor(() => expect(result.current.routePreferenceToSend).toEqual({ axis_a: 0.7, axis_b: 0.3 }));
  });
});

describe("道ごとの避け方", () => {
  const [{ key: rowKey }] = AVOIDABLE_ROWS;
  const otherLevel = AVOIDANCE_LEVELS.find(({ key }) => key !== DEFAULT_ROAD_AVOIDANCE[rowKey])!.key;

  it("変えた避け方は開き直しても残る", () => {
    const first = renderConditions();
    const changed = { ...DEFAULT_ROAD_AVOIDANCE, [rowKey]: otherLevel };

    act(() => first.result.current.setRoadAvoidance(changed));

    expect(reopen(first).result.current.roadAvoidance).toEqual(changed);
  });

  it("保存値は今の行へ揃え（今は無い行を落とし、無い行・読めない段は既定）、読めない保存値は既定に戻す", () => {
    const [, { key: unreadableKey }] = AVOIDABLE_ROWS;
    window.localStorage.setItem(
      "ridecompass:road-avoidance",
      JSON.stringify({ [rowKey]: otherLevel, [unreadableKey]: "retired_level", "retired.row": "exclude" }),
    );
    expect(renderConditions().result.current.roadAvoidance).toEqual({
      ...DEFAULT_ROAD_AVOIDANCE,
      [rowKey]: otherLevel,
    });

    window.localStorage.setItem("ridecompass:road-avoidance", "{broken");
    expect(renderConditions().result.current.roadAvoidance).toEqual(DEFAULT_ROAD_AVOIDANCE);
  });
  it("保存が無ければ、国道・主要地方道をなるべく避け、ほかの道は通る", () => {
    const avoided = ["highway.trunk", "highway.primary"];

    expect(renderConditions().result.current.roadAvoidance).toEqual(
      Object.fromEntries(AVOIDABLE_ROWS.map(({ key }) => [key, avoided.includes(key) ? "avoid" : "pass"])),
    );
  });

  it("分ける前の行の鍵で保存した段は、分けてできたどの行にも引き継ぎ、分けたあとの鍵で保存した段を先に読む", () => {
    window.localStorage.setItem(
      "ridecompass:road-avoidance",
      JSON.stringify({ "highway.arterial": "exclude", "highway.local": "avoid", "highway.cycleway": "exclude" }),
    );
    expect(renderConditions().result.current.roadAvoidance).toEqual({
      ...DEFAULT_ROAD_AVOIDANCE,
      "highway.trunk": "exclude",
      "highway.primary": "exclude",
      "highway.unclassified": "avoid",
      "highway.residential": "avoid",
      "highway.cycleway": "exclude",
      "highway.footway": "exclude",
    });

    window.localStorage.setItem(
      "ridecompass:road-avoidance",
      JSON.stringify({ "highway.cycleway": "exclude", "highway.footway": "pass" }),
    );
    expect(renderConditions().result.current.roadAvoidance).toMatchObject({
      "highway.cycleway": "exclude",
      "highway.footway": "pass",
    });
  });
});
