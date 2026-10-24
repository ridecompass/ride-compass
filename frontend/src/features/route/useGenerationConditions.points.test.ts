/**
 * 生成の条件（`useGenerationConditions.ts`）の地点（出発地以外）——地図のタップで置く地点の選び（経由地は足すか、何番目を
 * 置き直すか）と、経由地・目的地を動かす・消すことと、検索・名前のある点で置いた地点の候補（その位置のままの間だけ）。
 * 地点は保存しない。
 *
 * ここで見ないもの:
 * - 周回の間に覚えておく目的地 → `useGenerationConditions.test.ts`
 * - 地図で置いた出発地を位置の持ち主が受け取ったあと → `hooks/useLocation.test.ts`
 * - 地図のタップが選んだ地点を置く場面（「ルート設定」の「条件」タブが効いている間だけ） → `app/page.map.test.tsx`
 * - 条件を生成へ送る形 → `useRouteGeneration.test.ts`
 *
 * 差し替えたもの: 軸カタログの応答（網の層。届かないまま）。保存はテスト環境の`localStorage`を本物のまま使い、
 * 開き直しは同じ保存の上でフックを描き直して作る。
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { heldReplies, onBackend } from "@/testing/backendServer";
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
  onBackend("GET", "/api/axis-catalog", heldReplies().reply);
});

describe("地点", () => {
  // 目的地を置くのは周回を外した間（周回の間の目的地は上の「周回」）。
  beforeEach(() => window.localStorage.setItem("ridecompass:loop", "false"));

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

  it("生成が受け付ける数に達したら、検索で選んだ地点も経由地に足さない（開いた候補の一覧から、達した後にも選べる）", () => {
    const max = routeGenerateConfig.max_waypoints;
    const { result } = renderConditions();
    act(() => result.current.selectPoint({ role: "waypoint", index: null }));
    for (let i = 0; i < max; i++) act(() => result.current.placeAtSelected(point(i), null));

    act(() => result.current.placeFound("waypoint", candidateAt(A, "寄る店"), null));

    expect(result.current.waypoints).toEqual([...Array(max).keys()].map(point));
    expect(result.current.foundAt(A)).toBeNull();
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

  it.each([
    // 番号を詰めた後ろの経由地を選んだままにすると、地図のタップが選んでいない経由地を動かす。
    {
      label: "選んだ経由地が消えたら、出発地を選んでいることに戻る",
      selected: 1,
      removed: 1,
      after: { role: "origin" },
    },
    {
      label: "前の経由地が消えたら、選んだ経由地の番号を詰める",
      selected: 2,
      removed: 0,
      after: { role: "waypoint", index: 1 },
    },
    {
      label: "後ろの経由地が消えても、選んだ経由地は変わらない",
      selected: 0,
      removed: 1,
      after: { role: "waypoint", index: 0 },
    },
  ])("$label", ({ selected, removed, after }) => {
    const { result } = renderConditions();
    act(() => result.current.selectPoint({ role: "waypoint", index: null }));
    for (const at of [A, B, C]) act(() => result.current.placeAtSelected(at, null));
    act(() => result.current.selectPoint({ role: "waypoint", index: selected }));

    act(() => result.current.removeWaypoint(removed));

    expect(result.current.selectedPoint).toEqual(after);
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
