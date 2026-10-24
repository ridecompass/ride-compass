/**
 * 生成の条件（`useGenerationConditions.ts`）——周回か・全長の目標を決めるか・距離・候補数・重み・道ごとの避け方と、周回の間に
 * 覚えておく目的地を返す。保存する値（地点以外）は開き直しても残り、読むときに今の画面が受け付ける範囲・
 * 今の項目へ揃える。重みは軸カタログの公開軸へ揃えた値を返し、送るのは上書きを有効にしてカタログが届いた後だけ。
 *
 * ここで見ないもの:
 * - 地点（出発地以外）の置き方・動かし方・消し方と、検索・名前のある点で置いた地点の候補 →
 *   `useGenerationConditions.points.test.ts`
 * - 重みの揃え方の細部（増えた軸を既定の重みで補う・消えた軸を外す・取得が決まるまで揃えない） →
 *   `routePreferenceSync.test.ts`。ここでは揃えた値を返すことを1件ずつ見る
 * - 重みを送るかの判断（上書きしていない・カタログが届かない間は送らない） → `routePreferenceSync.test.ts`。
 *   ここでは開き直した後に送る重みを1件見る
 * - 保存の読み書きそのもの（読めない・書けない端末で既定値になる） → `hooks/useStoredState.test.ts`
 * - 地図で置いた出発地を位置の持ち主が受け取ったあと → `hooks/useLocation.test.ts`
 * - 地図のタップが選んだ地点を置く場面（「ルート設定」の「条件」タブが効いている間だけ） → `app/page.map.test.tsx`
 * - 条件を生成へ送る形 → `useRouteGeneration.test.ts`
 *
 * 差し替えたもの: 軸カタログの応答（網の層）。保存はテスト環境の`localStorage`を
 * 本物のまま使い、開き直しは同じ保存の上でフックを描き直して作る。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { heldReplies, onBackend, serveAxisCatalog } from "@/testing/backendServer";
import {
  AVOIDANCE_LEVELS,
  avoidanceRow,
  catalogEntry,
  catalogResponse,
  roadClassCatalog,
  TWO_AXIS_CATALOG,
} from "@/testing/catalogAxes";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import type { Coordinates } from "@/types/route";

import { useGenerationConditions } from "./useGenerationConditions";

const A: Coordinates = { latitude: 35.1, longitude: 139.1 };
const B: Coordinates = { latitude: 35.2, longitude: 139.2 };

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
  it("変えた避け方は開き直しても残る", () => {
    const first = renderConditions();

    act(() => first.result.current.setRoadAvoidance({ gravel: "exclude" }));

    expect(reopen(first).result.current.roadAvoidance).toEqual({ gravel: "exclude" });
  });

  // 行は軸カタログが届くまで分からず、今の行に無い鍵も前の鍵として読まれうるので、鍵では落とさない（今の行へ揃えるのはbackend）。
  it("保存値は段として読める鍵だけを残す", () => {
    window.localStorage.setItem(
      "ridecompass:road-avoidance",
      JSON.stringify({ gravel: "exclude", unpaved: "retired_level", "retired.row": "avoid" }),
    );
    expect(renderConditions().result.current.roadAvoidance).toEqual({ gravel: "exclude", "retired.row": "avoid" });
  });

  it("軸カタログが届くと、前の鍵に選んだ段を今の鍵へ移して保存へ書き戻す", async () => {
    window.localStorage.setItem(
      "ridecompass:road-avoidance",
      JSON.stringify({ dirt: "avoid", mud: "exclude", gravel: "avoid", "retired.row": "avoid" }),
    );
    serveAxisCatalog(
      catalogResponse([], {
        road_classes: roadClassCatalog({
          avoidance: {
            levels: AVOIDANCE_LEVELS,
            rows: [
              avoidanceRow("unpaved", "surface", { former_keys: ["dirt", "mud"] }),
              avoidanceRow("gravel", "surface"),
            ],
          },
        }),
      }),
    );
    const { result } = renderConditions();

    const rewritten = { unpaved: "exclude", gravel: "avoid", "retired.row": "avoid" };
    await waitFor(() => expect(result.current.roadAvoidance).toEqual(rewritten));
    expect(JSON.parse(window.localStorage.getItem("ridecompass:road-avoidance")!)).toEqual(rewritten);
  });
});
