/**
 * `PlaceSearch/PointSearch.tsx`——地点の行に付く、その地点を住所・施設で探す小窓（「ルート設定」の条件タブの目的地の行から開く）。
 * 打つ欄は住所・施設の名前を入れて、地図の真ん中を添えて引き、候補（名前と施設の辺り）を欄の下に並べ、押した候補をその地点に置いて
 * 閉じる。打ちかけでも、決まった文字数から、打つのが止まると引く（かな漢字の変換中は引かない）。文字数に足りなくなると候補を下げる。
 * 引いたあとに地図を動かしても引き直さず、Enter でその時の地図の真ん中で引き直す。引けないとき・当たらないときはそう出す。
 * 打つ前は「現在地」「地図で置く」と、置いている地点の保存のチップを出す。✕・Escape で閉じると打った文字を消す。開いた時点で、
 * PC は欄へ移らず、スマホは欄へ移り（キーボードを出す）、小窓の中を押しても欄から外れない（キーボードを出したまま押せる）。
 *
 * ここで見ないもの:
 * - 打つ前に出す保存した地点と検索の履歴・候補の☆での保存 → `PlaceSearch/PointSearch.saved.test.tsx`
 * - 置いた地点を地図に出して寄せること・小窓を開いたまま地図を押すと閉じるだけで置かないこと → `app/page.places.test.tsx`
 * - スマホで「戻る」が小窓だけを閉じること・小窓をキーボードの上の見える範囲に収めること（実際のブラウザの履歴と
 *   レイアウトの実寸） → `e2e/destination.spec.ts`
 * - 打ちかけの語の続きの候補・施設の候補とその並びを返すこと → backend の `tests/test_place_search_route.py`
 *
 * 差し替えたもの: 検索の口と辺りの口の応答（網の層）。
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onBackend, serveClientConfig } from "@/testing/backendServer";
import { NEAR_SENSOJI, TOKYO_STATION, renderSearch, searchBox, searchFor } from "@/testing/placeSearch";
import { AZA_CANDIDATE as AZA, FACILITY_CANDIDATE as FACILITY } from "@/testing/routeFixtures";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import type { Coordinates } from "@/types/route";

beforeEach(() => {
  window.localStorage.clear();
  onBackend("GET", "/api/place-area", () => Response.json({ area: null }));
  serveClientConfig();
});
afterEach(() => {
  vi.useRealTimers();
});

/** 引いたときに送った地図の真ん中（クエリの値）。 */
function sentCenter(center: Coordinates) {
  return { latitude: String(center.latitude), longitude: String(center.longitude) };
}

/** 打つのが止まってから引くまでの間を、引かないことを確かめられるだけ待つ。 */
function waitPastLookUpDelay() {
  return new Promise((resolve) => setTimeout(resolve, routeGenerateConfig.place_prediction_delay_seconds * 1000 + 100));
}

/** 候補の行（☆を除く、押すと置く所）の文。 */
function candidateRows(list: HTMLElement) {
  return within(list)
    .getAllByRole("button", { name: /^(?!.*保存)/ })
    .map((row) => row.textContent);
}

describe("PointSearch 打つ欄", () => {
  it("PC は開いた時点では欄へ移らず、探すとキーボードを閉じて住所・施設の候補（施設は辺りも）を並べ、押した候補を置いて閉じる", async () => {
    const sent = onBackend("GET", "/api/place-search", () => Response.json({ candidates: [AZA, FACILITY] }));
    const { onPlace } = await renderSearch();
    expect(searchBox()).not.toHaveFocus();

    await searchFor(" 丸の内 ");

    const list = await screen.findByRole("list", { name: "地点の候補" });
    expect(searchBox()).not.toHaveFocus();
    expect(sent.map((request) => request.query)).toEqual([{ q: "丸の内", ...sentCenter(TOKYO_STATION) }]);
    expect(candidateRows(list)).toEqual([AZA.name, `${FACILITY.name}${FACILITY.area}`]);

    await userEvent.click(within(list).getByRole("button", { name: new RegExp(`^${FACILITY.name}`) }));
    expect(onPlace).toHaveBeenCalledExactlyOnceWith({ role: "destination" }, FACILITY);
    expect(screen.queryByRole("dialog", { name: "目的地を探す" })).toBeNull();
  });

  it("スマホは開いた時点で欄へ移り、小窓の中のボタンを押しても欄から外れない", async () => {
    onBackend("GET", "/api/place-search", () => Response.json({ candidates: [FACILITY] }));
    await renderSearch({ isMobile: true });
    expect(searchBox()).toHaveFocus();

    await userEvent.type(searchBox(), "浅草寺{Enter}");
    await userEvent.click(searchBox());
    const list = await screen.findByRole("list", { name: "地点の候補" });
    await userEvent.click(within(list).getByRole("button", { name: `「${FACILITY.name}」を保存` }));

    expect(searchBox()).toHaveFocus();
  });

  it("打ちかけでも、決まった文字数から、打つのが止まると引く", async () => {
    const sent = onBackend("GET", "/api/place-search", () => Response.json({ candidates: [AZA] }));
    await renderSearch();
    const enough = "千代田区丸の内".slice(0, routeGenerateConfig.place_prediction_min_length);

    // 空白は数えない。
    await userEvent.type(searchBox(), ` ${enough.slice(0, -1)}`);
    await waitPastLookUpDelay();
    expect(sent).toEqual([]);

    await userEvent.type(searchBox(), enough.slice(-1));
    await screen.findByRole("list", { name: "地点の候補" });
    expect(sent.map((request) => request.query)).toEqual([{ q: enough, ...sentCenter(TOKYO_STATION) }]);
  });

  it("文字を引き始める長さより短くすると候補を下げ、打ち直すとその文字の候補を出す", async () => {
    const sent = onBackend("GET", "/api/place-search", (request) =>
      Response.json({ candidates: request.query.q === "浅草寺" ? [FACILITY] : [AZA] }),
    );
    await renderSearch();
    // 時計は打ち終えてから進める（本物の時計では、遅い機械で打鍵の間が引くまでの待ちを超え、打ちかけの文字で引く）。
    // `userEvent`は打つたびに本物の時計の`setTimeout`を待つので、偽の時計の下では打鍵を1字ずつ起こす。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const typeText = async (text: string) => {
      for (let end = 1; end <= text.length; end += 1)
        fireEvent.input(searchBox(), { target: { value: text.slice(0, end) } });
      await act(() => vi.advanceTimersByTimeAsync(routeGenerateConfig.place_prediction_delay_seconds * 1000));
    };
    const listed = () => vi.waitFor(() => screen.getByRole("list", { name: "地点の候補" }));

    await typeText("丸の内");
    await listed();

    // 空の欄は、どの引き始める長さにも足りない。
    fireEvent.input(searchBox(), { target: { value: "" } });
    expect(screen.queryByRole("list", { name: "地点の候補" })).toBeNull();

    await typeText("浅草寺");
    expect(candidateRows(await listed())).toEqual([`${FACILITY.name}${FACILITY.area}`]);
    expect(sent.map((request) => request.query.q)).toEqual(["丸の内", "浅草寺"]);
  });

  it("かな漢字の変換中は引かず、確定してから引く", async () => {
    const sent = onBackend("GET", "/api/place-search", () => Response.json({ candidates: [AZA] }));
    await renderSearch();
    const box = searchBox();

    fireEvent.compositionStart(box);
    fireEvent.input(box, { target: { value: "まるのうち" }, isComposing: true });
    await waitPastLookUpDelay();
    expect(sent).toEqual([]);

    fireEvent.input(box, { target: { value: "丸の内" }, isComposing: true });
    fireEvent.compositionEnd(box);
    await screen.findByRole("list", { name: "地点の候補" });
    expect(sent.map((request) => request.query)).toEqual([{ q: "丸の内", ...sentCenter(TOKYO_STATION) }]);
  });

  it("引いたあとに地図を動かしても引き直さず、Enter を押すとその地図の真ん中で引き直す（真ん中を作り直しても、位置が同じなら同じ真ん中）", async () => {
    const sent = onBackend("GET", "/api/place-search", () => Response.json({ candidates: [FACILITY] }));
    const { moveMap } = await renderSearch({ mapCenter: NEAR_SENSOJI });
    await searchFor("浅草寺");
    await screen.findByRole("list", { name: "地点の候補" });

    moveMap(TOKYO_STATION);
    await waitPastLookUpDelay();
    expect(sent.map((request) => request.query)).toEqual([{ q: "浅草寺", ...sentCenter(NEAR_SENSOJI) }]);

    await userEvent.type(searchBox(), "{Enter}");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    moveMap({ ...TOKYO_STATION });
    await userEvent.type(searchBox(), "{Enter}");
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.slice(1).map((request) => request.query)).toEqual([
      { q: "浅草寺", ...sentCenter(TOKYO_STATION) },
      { q: "浅草寺", ...sentCenter(TOKYO_STATION) },
    ]);
  });

  it("当たらなければそう出し、検索が使えなければ口の文を出す", async () => {
    onBackend("GET", "/api/place-search", () => Response.json({ candidates: [] }));
    await renderSearch();

    await searchFor("どこにもない");

    onBackend("GET", "/api/place-search", () =>
      Response.json({ detail: "対象範囲を読めませんでした" }, { status: 502 }),
    );
    await searchFor("丸の内");
    expect(await screen.findByRole("alert")).toHaveTextContent("対象範囲を読めませんでした");
  });

  it.each([
    ["✕", () => userEvent.click(screen.getByRole("button", { name: "検索を閉じる" }))],
    ["Escape", () => userEvent.keyboard("{Escape}")],
  ])("%sで閉じると、小窓を閉じて打った文字を消し、置かない", async (_, closeSearch) => {
    onBackend("GET", "/api/place-search", () => Response.json({ candidates: [AZA] }));
    const { onPlace } = await renderSearch();
    await searchFor("丸の内");
    await screen.findByRole("list", { name: "地点の候補" });

    await closeSearch();

    expect(screen.queryByRole("dialog", { name: "目的地を探す" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^目的地 / }));
    expect(searchBox()).toHaveValue("");
    expect(onPlace).not.toHaveBeenCalled();
  });
});

describe("PointSearch 打つ前のチップ", () => {
  it("「地図で置く」は置かずに小窓を閉じ、「現在地」はその地点を現在地に置いて閉じる", async () => {
    const { onPlace } = await renderSearch();

    await userEvent.click(screen.getByRole("button", { name: "地図で置く" }));
    expect(screen.queryByRole("dialog", { name: "目的地を探す" })).toBeNull();
    expect(onPlace).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^目的地 / }));
    await userEvent.click(screen.getByRole("button", { name: "現在地" }));
    expect(onPlace).toHaveBeenCalledExactlyOnceWith(
      { role: "destination" },
      expect.objectContaining({ name: "現在地", latitude: expect.any(Number), longitude: expect.any(Number) }),
    );
    expect(screen.queryByRole("dialog", { name: "目的地を探す" })).toBeNull();
  });

  it("置いている地点にだけ保存のチップを出す", async () => {
    await renderSearch();
    expect(screen.queryByRole("button", { name: /を保存/ })).toBeNull();
    await userEvent.keyboard("{Escape}");

    await userEvent.click(screen.getByRole("button", { name: /^出発地 / }));
    expect(screen.getByRole("button", { name: /を保存$/ })).toHaveAttribute("aria-pressed", "false");
  });
});
