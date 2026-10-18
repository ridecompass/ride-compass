/**
 * `useWayMaterials.ts`——地図が塗る軸の道ごとの材料を、画面のタイルと時刻で取り、軸ごとにまとめること。
 *
 * ここで見ないもの:
 * - 画面か対象の軸が無い間は取りに行かないこと → 読むだけの要求なので送ったかを見ない（testing.md「確かめる高さ」）。
 *   要求はタイルと軸の組から作るので、どちらかが無ければ1件も作られない。画面が無くなれば空へ戻すことは下のテストが見る
 * - 走る向き・速度を変えても取り直さないこと → フックはそれらを受け取らない。地図の側で向きを変えても取り直さないことは
 *   `view/useMapView.test.ts` が見る
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAP_FETCH_DEBOUNCE_MS } from "@/hooks/useDebouncedValue";
import { heldReplies, onBackend } from "@/testing/backendServer";
import { mapCatalogOf } from "@/testing/mapAxisCatalog";
import { dedicatedEntry } from "@/testing/catalogAxes";
import type { MapViewport } from "@/features/map/layers/windLayer";

import { useWayMaterials } from "./useWayMaterials";

const { dedicatedAxes } = mapCatalogOf([
  dedicatedEntry("timed", [1], { dynamic_way_value_conditions: ["at", "bearing_deg", "speed_kmh"] }),
  dedicatedEntry("static", [1], { dynamic_way_value_conditions: ["bearing_deg"] }),
]);
const [, STATIC] = dedicatedAxes;
// z14で横2枚×縦1枚のタイルにまたがる範囲
const VIEWPORT: MapViewport = { west: 139.76, south: 35.68, east: 139.77, north: 35.685, zoom: 14, bearing: 0 };
const AT = new Date("2026-09-24T00:00:00Z");
const LATER = new Date("2026-09-24T01:00:00Z");

const WAY_MATERIALS = "/api/region/way-materials/:axisId/:z/:x/:y";

/**
 * 道ごとの材料の代役。問われた軸・タイルのx・時刻（無ければ`-`）を道の鍵`軸@x@時刻`に書き、材料`x`にタイルのxを返す。
 * `failsAt`が真を返すタイルは失敗で答える。
 */
function serveWayMaterials(failsAt: (x: number) => boolean = () => false) {
  onBackend("GET", WAY_MATERIALS, ({ path, query }) => {
    const [axisId, , x] = path.split("/").slice(-4);
    if (failsAt(Number(x))) return new Response(null, { status: 500 });
    return Response.json({ [`${axisId}@${x}@${query.at ?? "-"}`]: { x: Number(x) } });
  });
}

type Results = { current: ReturnType<typeof useWayMaterials> };

// 入力の変化を取得へ渡すまでの間引きは偽の時計で待ち（`vi.waitFor`が確かめのたびに偽の時計を進める）、取得の結果は
// 網を通って、どの軸も取り終えるまで待つ（届くまでの時間は CI の負荷で変わる）。
async function fetched(result: Results) {
  await vi.waitFor(() => {
    expect(result.current.size).toBeGreaterThan(0);
    for (const axis of result.current.values()) expect(axis).toMatchObject({ loading: false, hasFetched: true });
  });
}

/** 入力の変化が間引きを抜けるまで偽の時計を進める（取り直すなら、ここで取り直しが始まる）。 */
const debounced = () => act(() => vi.advanceTimersByTimeAsync(MAP_FETCH_DEBOUNCE_MS));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  serveWayMaterials();
});
afterEach(() => {
  vi.useRealTimers();
});

type Props = { axes: typeof dedicatedAxes; viewport: MapViewport | null; at: Date };
function render(initialProps: Props) {
  return renderHook(({ axes, viewport, at }: Props) => useWayMaterials(axes, viewport, at), { initialProps });
}
const wayKeys = (materials: ReadonlyMap<string, unknown> | undefined) => [...(materials?.keys() ?? [])];

describe("useWayMaterials（道ごとの材料）", () => {
  it("画面を覆うタイルごとに軸の材料を取り、1つにまとめる", async () => {
    const { result } = render({ axes: [STATIC], viewport: VIEWPORT, at: AT });
    await fetched(result);
    const materials = result.current.get("static")!.materials;
    expect(new Set([...materials.values()].map(({ x }) => x)).size).toBeGreaterThan(1);
    expect([...materials].every(([key, { x }]) => key.startsWith(`static@${x}@`))).toBe(true);
    expect(result.current.get("static")).toMatchObject({ loading: false, error: false, hasFetched: true });
  });

  it("時刻は、要ると宣言した軸のリクエストにだけ載せる", async () => {
    const { result } = render({ axes: dedicatedAxes, viewport: VIEWPORT, at: AT });
    await fetched(result);
    const timesOf = (axisId: string) =>
      new Set(wayKeys(result.current.get(axisId)?.materials).map((key) => key.split("@")[2]));
    expect(timesOf("timed")).toEqual(new Set([AT.toISOString()]));
    expect(timesOf("static")).toEqual(new Set(["-"]));
  });

  it("時刻が変わると時刻の要る軸だけを取り直し、取り直す間は前の材料を残して読み込み中にする", async () => {
    const { result, rerender } = render({ axes: dedicatedAxes, viewport: VIEWPORT, at: AT });
    await fetched(result);
    const staticBefore = result.current.get("static");
    const held = heldReplies();
    onBackend("GET", WAY_MATERIALS, held.reply);

    rerender({ axes: dedicatedAxes, viewport: VIEWPORT, at: LATER });
    await vi.waitFor(() => expect(held.arrived()).toBeGreaterThan(0));
    expect(result.current.get("timed")).toMatchObject({ loading: true, hasFetched: true });
    expect(result.current.get("timed")?.materials.size).toBeGreaterThan(0);
    expect(result.current.get("static")).toBe(staticBefore);

    for (let index = 0; index < held.arrived(); index += 1) await held.answer(index, Response.json({ next: { x: 1 } }));
    await vi.waitFor(() => expect(result.current.get("timed")?.loading).toBe(false));
  });

  it("入力が何も変わらなければ取り直さず、結果の参照も変えない", async () => {
    const { result, rerender } = render({ axes: dedicatedAxes, viewport: VIEWPORT, at: AT });
    await fetched(result);
    const before = result.current;
    rerender({ axes: dedicatedAxes, viewport: { ...VIEWPORT }, at: AT });
    await debounced();
    expect(result.current).toBe(before);
  });

  it("取得に失敗した軸は、入力が同じでも次に取り直すときに一緒に取り直す", async () => {
    serveWayMaterials(() => true);
    const { result, rerender } = render({ axes: dedicatedAxes, viewport: VIEWPORT, at: AT });
    await fetched(result);
    expect(result.current.get("static")?.error).toBe(true);
    serveWayMaterials();
    rerender({ axes: dedicatedAxes, viewport: VIEWPORT, at: LATER });
    await vi.waitFor(() => expect(result.current.get("static")?.error).toBe(false));
    expect(result.current.get("static")?.materials.size).toBeGreaterThan(0);
  });

  it("対象から外れた軸の結果は落とし、画面が無くなれば空へ戻す", async () => {
    const { result, rerender } = render({ axes: dedicatedAxes, viewport: VIEWPORT, at: AT });
    await fetched(result);
    rerender({ axes: [STATIC], viewport: VIEWPORT, at: AT });
    await fetched(result);
    expect([...result.current.keys()]).toEqual(["static"]);
    rerender({ axes: [STATIC], viewport: null, at: AT });
    await debounced();
    expect(result.current.size).toBe(0);
  });
});
