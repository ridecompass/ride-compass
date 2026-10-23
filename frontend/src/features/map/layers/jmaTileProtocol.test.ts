// @vitest-environment node
import { inflateSync } from "node:zlib";

import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));
// 配信のオリジンは`@/lib/tileBaseUrl`が決める（`src/lib/tileBaseUrl.test.ts`）。網へ出すURLは絶対にするため、ここで固定する。
vi.mock("@/lib/tileBaseUrl", () => ({ tileBaseUrl: () => "https://tiles.test" }));

import { heldReplies, inTurn, onUrl } from "@/testing/backendServer";
import { jmaDeliveryOf, jmaTileUrlAt } from "@/testing/jmaDeliveries";

import { jmaTilePayload } from "./jmaDelivery";

type Handler = (params: { url: string }, abort: AbortController) => Promise<{ data: ArrayBuffer | Uint8Array }>;

const BASETIME = "20260924000000";
const VALIDTIME = "20260924010000";
const FRAME = { basetime: BASETIME, member: "none", validtime: VALIDTIME };
/** そのコマのタイルのテンプレート（描画ペイロードが持つもの）と、地図ライブラリが座標を埋めたURL。 */
const TEMPLATE = jmaTilePayload("rasterTile", jmaDeliveryOf("inund"), FRAME).tileUrlTemplate;
const at = (template: string, x: number, y: number) => jmaTileUrlAt(template, 5, x, y);
const EMPTY_PNG_URL = at(TEMPLATE, 28, 12);
const PRESENT_PNG_URL = at(TEMPLATE, 28, 13);
const EMPTY_PBF_URL = at(jmaTilePayload("vectorTile", jmaDeliveryOf("flood"), FRAME).tileUrlTemplate, 28, 12);
const INDEX = {
  available: true,
  coverage: { min_longitude: 122, min_latitude: 24, max_longitude: 146, max_latitude: 46 },
  elements: {
    inund: { basetime: BASETIME, validtime: VALIDTIME, member: "none", zooms: { "5": [[28, 13]] } },
    flood: { basetime: BASETIME, validtime: VALIDTIME, member: "none", zooms: {} },
  },
};

// 失敗の記録とインデックスはモジュールが持つため、テストごとに読み込み直す（地図のライブラリの代役と調査用のログも、
// 読み込み直したモジュールが使うものを読む）。
async function load() {
  vi.resetModules();
  const debug = await import("@/lib/debugLog");
  debug.setDebugEnabled(true);
  const protocol = await import("./jmaTileProtocol");
  protocol.registerJmaTileProtocol();
  const { protocolHandler } = (await import("maplibre-gl")) as unknown as typeof import("@/testing/maplibre");
  const handler = protocolHandler(protocol.withJmaTileProtocol("").split("://")[0]) as Handler;
  const request = (url: string, abort = new AbortController()) =>
    handler({ url: protocol.withJmaTileProtocol(url) }, abort);
  const warnings = () => debug.getDebugLogEntries().filter((entry) => entry.level === "warn");
  return { ...protocol, request, warnings };
}

/** 配信元のタイルへの要求（`TEMPLATE`の要素の全タイル）に`reply`で応える。 */
const serveTiles = (reply: () => Response | Promise<Response>) =>
  onUrl(`${TEMPLATE.slice(0, TEMPLATE.indexOf("{"))}*`, reply);

beforeEach(() => {
  // 調査用のログは、記録と同時にコンソールへも出す。
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
/** PNGの画素がすべて完全な透明か（IDATを展開し、各行のフィルタ種別の後ろを見る）。 */
function isFullyTransparentPng(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idat: number[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === "IDAT") idat.push(...bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Uint8Array.from(idat));
  expect(raw.length).toBeGreaterThan(1);
  return raw.subarray(1).every((value) => value === 0);
}

describe("jmatile:// プロトコル", () => {
  it("空と分かっているタイルはネットワークへ出さず、完全に透明な画像を毎回新しく作って返す（ベクタは0バイト＝地物なし）", async () => {
    const { setJmaTileIndex, request } = await load();
    setJmaTileIndex(INDEX);
    const first = (await request(EMPTY_PNG_URL)).data as Uint8Array;
    const second = (await request(EMPTY_PNG_URL)).data as Uint8Array;
    expect((await request(EMPTY_PBF_URL)).data).toHaveLength(0);
    expect(isFullyTransparentPng(first)).toBe(true);
    expect(second.buffer).not.toBe(first.buffer);
  });

  it("空と分からないタイルは実URLへ取りに行き、中身をそのまま返す", async () => {
    const { request } = await load();
    onUrl(EMPTY_PNG_URL, () => new Response(new Uint8Array([1, 2, 3])));
    const { data } = await request(EMPTY_PNG_URL);
    expect(new Uint8Array(data as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("配信の失敗の記録", () => {
  it("5xxは空タイルで代替し、そのコマのタイルのテンプレートを失敗として記録して購読者へ知らせる", async () => {
    const { request, jmaTileFailures, subscribeJmaTileFailures, warnings } = await load();
    const listener = vi.fn();
    subscribeJmaTileFailures(listener);
    serveTiles(() => new Response(null, { status: 503 }));

    const { data } = await request(PRESENT_PNG_URL);
    expect(isFullyTransparentPng(data as Uint8Array)).toBe(true);
    expect(jmaTileFailures()).toEqual(new Map([["inund", TEMPLATE]]));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(warnings()).toEqual([expect.objectContaining({ category: "weather" })]);
  });

  it("同じ失敗が続く間は記録の参照を変えず、知らせもしない", async () => {
    const { request, jmaTileFailures, subscribeJmaTileFailures } = await load();
    serveTiles(() => new Response(null, { status: 500 }));
    await request(PRESENT_PNG_URL);
    const recorded = jmaTileFailures();
    const listener = vi.fn();
    subscribeJmaTileFailures(listener);
    await request(at(TEMPLATE, 29, 13));
    expect(jmaTileFailures()).toBe(recorded);
    expect(listener).not.toHaveBeenCalled();
  });

  it("配信元が応答すれば（404の空応答も含む）その要素の失敗を消す", async () => {
    const { request, jmaTileFailures, warnings } = await load();
    serveTiles(
      inTurn(
        new Response(null, { status: 502 }),
        new Response(null, { status: 404 }),
        new Response(null, { status: 502 }),
        new Response(new Uint8Array([1])),
      ),
    );
    await request(PRESENT_PNG_URL);
    await request(PRESENT_PNG_URL);
    expect(jmaTileFailures().size).toBe(0);
    expect(warnings()).toHaveLength(1);

    await request(PRESENT_PNG_URL);
    await request(PRESENT_PNG_URL);
    expect(jmaTileFailures().size).toBe(0);
  });

  it("前のコマのタイルが返っても、いま描くコマの失敗は消さない（失敗の知らせが出ないまま、壊れたコマが透明に見える）", async () => {
    const { request, jmaTileFailures } = await load();
    const previous = jmaTilePayload("rasterTile", jmaDeliveryOf("inund"), {
      ...FRAME,
      basetime: "20260923230000",
    }).tileUrlTemplate;
    serveTiles(() => new Response(null, { status: 503 }));
    onUrl(`${previous.slice(0, previous.indexOf("{"))}*`, () => new Response(new Uint8Array([1])));
    await request(PRESENT_PNG_URL);
    await request(at(previous, 28, 13));
    expect(jmaTileFailures().get("inund")).toBe(TEMPLATE);
  });

  it("到達できなければ失敗として記録して例外を返す。地図が取り消すと取りに行った要求も止め、失敗に数えない", async () => {
    const { request, jmaTileFailures } = await load();
    // 網は、中断されるまで答えない。
    serveTiles(heldReplies().reply);
    const abort = new AbortController();
    const pending = request(PRESENT_PNG_URL, abort);
    abort.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(jmaTileFailures().size).toBe(0);

    serveTiles(() => HttpResponse.error());
    await expect(request(PRESENT_PNG_URL)).rejects.toThrow("fetch failed");
    expect(jmaTileFailures().get("inund")).toBe(TEMPLATE);
  });

  it("購読を外せば知らせない", async () => {
    const { request, subscribeJmaTileFailures } = await load();
    const listener = vi.fn();
    subscribeJmaTileFailures(listener)();
    serveTiles(() => new Response(null, { status: 500 }));
    await request(PRESENT_PNG_URL);
    expect(listener).not.toHaveBeenCalled();
  });
});
