/**
 * `useWayMaterials.ts`——地図が塗るレンズの道ごとの材料を、画面のタイルと走る条件で取り、レンズごとにまとめること。
 *
 * ここで見ないもの:
 * - 画面か対象のレンズが無い間は取りに行かないこと → 送ったかを見ない。
 *   要求はタイルとレンズの組から作るので、どちらかが無ければ1件も作られない。画面が無くなれば空へ戻すことは下のテストが見る
 * - 走る向きを段に丸めることと、向きを変えても取り直さないこと → `view/useMapView.test.ts`
 * - 利用者の値を要求へ載せる形 → `lib/costPreference.test.ts`
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAP_FETCH_DEBOUNCE_MS } from "@/hooks/useDebouncedValue";
import { heldReplies, onBackend } from "@/testing/backendServer";
import { mapCatalogFor } from "@/testing/mapCatalog";
import { TWO_COST_AXES } from "@/testing/costAxes";
import type { MapViewport } from "@/features/map/view/mapLook";
import type { RideConditions } from "@/features/map/regionApi";

import { useWayMaterials } from "./useWayMaterials";
import { STANDARD_COST_PREFERENCE } from "@/lib/costPreference";

/** 総合・登坂・振動のレンズ。材料の要求へは出発時刻と想定速度を載せる（一覧のレンズごとの`map_lens.material_conditions`）。 */
const { lenses: LENSES } = mapCatalogFor();
const ASCENT = LENSES.find((lens) => lens.lensId === "ascent")!;
const VIBRATION = LENSES.find((lens) => lens.lensId === "vibration")!;
/** 登坂と振動（同じ参照を渡し続ける。hook は呼び出し側が安定した参照を渡す約束）。 */
const TWO_LENSES = [ASCENT, VIBRATION];
/** 材料の要求へ出発時刻を載せない（速度だけを載せる）登坂のレンズ。 */
const UNTIMED_ASCENT = mapCatalogFor({
  ...TWO_COST_AXES,
  axes: [
    { ...TWO_COST_AXES.axes[0], map_lens: { ...TWO_COST_AXES.axes[0].map_lens, material_conditions: ["speed_kmh"] } },
    ...TWO_COST_AXES.axes.slice(1),
  ],
}).lenses.find((lens) => lens.lensId === "ascent")!;
/** どの走る条件でも値が変わらない（材料の要求へ何も載せない）レンズ。 */
const UNCONDITIONED_ASCENT = mapCatalogFor({
  ...TWO_COST_AXES,
  axes: [
    { ...TWO_COST_AXES.axes[0], map_lens: { ...TWO_COST_AXES.axes[0].map_lens, material_conditions: [] } },
    ...TWO_COST_AXES.axes.slice(1),
  ],
}).lenses.find((lens) => lens.lensId === "ascent")!;
// z14で横2枚×縦1枚のタイルにまたがる範囲
const VIEWPORT: MapViewport = { west: 139.76, south: 35.68, east: 139.77, north: 35.685, zoom: 14, bearing: 0 };
/** `VIEWPORT`から東へタイル1枚分（z14の幅）動かした範囲。 */
const NEXT_TILE_VIEWPORT = { ...VIEWPORT, west: VIEWPORT.west + 360 / 2 ** 14, east: VIEWPORT.east + 360 / 2 ** 14 };
/** `VIEWPORT`とタイルの重ならない範囲。 */
const ELSEWHERE_VIEWPORT = { ...VIEWPORT, west: VIEWPORT.west + 1, east: VIEWPORT.east + 1 };
/** 出発の時刻を含むレンズのコマの印と、その次のコマの印。 */
const FRAME = "v1-2026092409";
const NEXT_FRAME = "v1-2026092410";
const CONDITIONS: RideConditions = {
  lensFrame: FRAME,
  bearingDeg: 0,
  speedKmh: 20,
  paintedLensId: null,
};

const WAY_MATERIALS = "/api/region/lens/:lensId/:z/:x/:y";

/**
 * 道ごとの材料の代役。問われたレンズ・タイルのx・時刻・速度（無ければ`-`）を道の鍵`レンズ@x@時刻@速度`に書き、材料`x`に
 * タイルのxを返す。
 * `failsAt`が真を返すタイルは失敗で答える。
 */
function serveWayMaterials(failsAt: (x: number) => boolean = () => false) {
  return onBackend("GET", WAY_MATERIALS, ({ path, query }) => {
    const [lensId, , x] = path.split("/").slice(-4);
    if (failsAt(Number(x))) return new Response(null, { status: 500 });
    return Response.json({
      materials: { [`${lensId}@${x}@${query.frame ?? "-"}@${query.speed_kmh ?? "-"}`]: { x: Number(x) } },
      wind_previous_run_from: null,
    });
  });
}

type Results = { current: ReturnType<typeof useWayMaterials> };

// 入力の変化を取得へ渡すまでの間引きは偽の時計で待ち（`vi.waitFor`が確かめのたびに偽の時計を進める）、取得の結果は
// 網を通って、どのレンズも取り終えるまで待つ（届くまでの時間は CI の負荷で変わる）。
async function fetched(result: Results) {
  await vi.waitFor(() => {
    expect(result.current.size).toBeGreaterThan(0);
    for (const lens of result.current.values()) expect(lens).toMatchObject({ loading: false, hasFetched: true });
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

type Props = { axes: typeof LENSES; viewport: MapViewport | null; conditions: typeof CONDITIONS };
function render(initialProps: Props) {
  return renderHook(
    ({ axes, viewport, conditions }: Props) =>
      useWayMaterials(axes, viewport, conditions, STANDARD_COST_PREFERENCE, null),
    {
      initialProps,
    },
  );
}
const wayKeys = (materials: ReadonlyMap<string, unknown> | undefined) => [...(materials?.keys() ?? [])];

describe("useWayMaterials（道ごとの材料）", () => {
  it("画面を覆うタイルごとにレンズの材料を取り、1つにまとめる", async () => {
    const { result } = render({ axes: [ASCENT], viewport: VIEWPORT, conditions: CONDITIONS });
    await fetched(result);
    const materials = result.current.get("ascent")!.materials;
    expect(new Set([...materials.values()].map(({ x }) => x)).size).toBeGreaterThan(1);
    expect([...materials].every(([key, { x }]) => key.startsWith(`ascent@${x}@`))).toBe(true);
    expect(result.current.get("ascent")).toMatchObject({ loading: false, error: null, hasFetched: true });
  });

  it.each([
    ["出発時刻のコマと想定速度を載せる", ASCENT, `${FRAME}@20`],
    ["想定速度だけを載せる", UNTIMED_ASCENT, "-@20"],
    ["何も載せない", UNCONDITIONED_ASCENT, "-@-"],
  ])("出発時刻と想定速度は、レンズが載せると宣言したものだけを要求に載せる: %s", async (_, lens, expected) => {
    const { result } = render({ axes: [lens], viewport: VIEWPORT, conditions: CONDITIONS });
    await fetched(result);

    const conditions = new Set(
      wayKeys(result.current.get("ascent")?.materials).map((key) => key.split("@").slice(2).join("@")),
    );
    expect(conditions).toEqual(new Set([expected]));
  });

  it("時刻に依るレンズは、コマの一覧が届くまで取らず、出発時刻のコマが無ければ取れないことを出す", async () => {
    const waiting = render({ axes: [ASCENT], viewport: VIEWPORT, conditions: { ...CONDITIONS, lensFrame: undefined } });
    await debounced();
    expect(waiting.result.current.get("ascent")).toMatchObject({ loading: false, hasFetched: false });

    const outside = render({ axes: [ASCENT], viewport: VIEWPORT, conditions: { ...CONDITIONS, lensFrame: null } });
    await vi.waitFor(() => expect(outside.result.current.get("ascent")?.error).toBe("出発時刻の風の予報がありません"));
  });

  it("出発時刻のコマが変わると取り直し、取り直す間は前の材料を残して読み込み中にする", async () => {
    const { result, rerender } = render({ axes: [ASCENT], viewport: VIEWPORT, conditions: CONDITIONS });
    await fetched(result);
    const held = heldReplies();
    onBackend("GET", WAY_MATERIALS, held.reply);

    rerender({ axes: [ASCENT], viewport: VIEWPORT, conditions: { ...CONDITIONS, lensFrame: NEXT_FRAME } });
    await vi.waitFor(() => expect(held.arrived()).toBeGreaterThan(0));
    expect(result.current.get("ascent")).toMatchObject({ loading: true, hasFetched: true });
    expect(result.current.get("ascent")?.materials.size).toBeGreaterThan(0);

    for (let index = 0; index < held.arrived(); index += 1) await held.answer(index, Response.json({ next: { x: 1 } }));
    await vi.waitFor(() => expect(result.current.get("ascent")?.loading).toBe(false));
  });

  it("入力が何も変わらなければ取り直さず、結果の参照も変えない", async () => {
    const { result, rerender } = render({ axes: TWO_LENSES, viewport: VIEWPORT, conditions: CONDITIONS });
    await fetched(result);
    const before = result.current;
    rerender({ axes: TWO_LENSES, viewport: { ...VIEWPORT }, conditions: CONDITIONS });
    await debounced();
    expect(result.current).toBe(before);
  });

  // 材料の要求はタイルごとに backend の回数の制限に数えられるので、送った数を見る。
  it("地図を動かしても、前に取ったタイルは取り直さず、新しく入ったタイルだけを取る", async () => {
    const sent = serveWayMaterials();
    const { result, rerender } = render({ axes: [ASCENT], viewport: VIEWPORT, conditions: CONDITIONS });
    await fetched(result);
    expect(sent).toHaveLength(2);

    rerender({ axes: [ASCENT], viewport: NEXT_TILE_VIEWPORT, conditions: CONDITIONS });
    await debounced();
    await fetched(result);
    rerender({ axes: [ASCENT], viewport: VIEWPORT, conditions: CONDITIONS });
    await debounced();
    await fetched(result);

    const paths = sent.map(({ path }) => path);
    expect(paths).toHaveLength(3);
    expect(new Set(paths).size).toBe(3);
    expect(result.current.get("ascent")?.materials.size).toBe(2);
  });

  it("取得に失敗したタイルは取っておかず、次に見えたときに取り直す", async () => {
    serveWayMaterials(() => true);
    const { result, rerender } = render({ axes: [ASCENT], viewport: VIEWPORT, conditions: CONDITIONS });
    await fetched(result);
    expect(result.current.get("ascent")?.error).toMatch(/道路の塗りの値の取得に失敗しました/);
    serveWayMaterials();
    rerender({ axes: [ASCENT], viewport: ELSEWHERE_VIEWPORT, conditions: CONDITIONS });
    await debounced();
    await fetched(result);
    rerender({ axes: [ASCENT], viewport: VIEWPORT, conditions: CONDITIONS });
    await debounced();
    await vi.waitFor(() => expect(result.current.get("ascent")?.error).toBeNull());
    expect(result.current.get("ascent")?.materials.size).toBeGreaterThan(0);
  });

  it("対象から外れたレンズの結果は落とし、画面が無くなれば空へ戻す", async () => {
    const { result, rerender } = render({ axes: TWO_LENSES, viewport: VIEWPORT, conditions: CONDITIONS });
    await fetched(result);
    rerender({ axes: [VIBRATION], viewport: VIEWPORT, conditions: CONDITIONS });
    await fetched(result);
    expect([...result.current.keys()]).toEqual(["vibration"]);
    rerender({ axes: [VIBRATION], viewport: null, conditions: CONDITIONS });
    await debounced();
    expect(result.current.size).toBe(0);
  });
});
