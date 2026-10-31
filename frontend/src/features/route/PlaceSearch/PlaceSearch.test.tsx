/**
 * `PlaceSearch/PlaceSearch.tsx`——地図の上端の、地点を住所・施設で探す欄。打つ欄は住所・施設の名前を入れて、地図の真ん中を添えて
 * 引き、候補（表示名・施設の辺り・地図の真ん中からの直線距離）を欄の下に並べ、選んだ候補を上げる。打ちかけでも、
 * 決まった文字数から、打つのが止まると引く（かな漢字の変換中は引かない）。文字数に足りなくなると候補を下げる。引いたあとに地図を
 * 動かしても引き直さず、虫眼鏡を押すとその時の地図の真ん中で引き直す。引けないとき・当たらないときはそう出す。打つ欄を押すと保存した地点を出し、打った文字を名前に含むものに
 * 絞り、選んだ地点を上げる。住所・施設の候補か履歴を選ぶと履歴に残し、次に欄を押すと保存した地点の下に新しい順に出し、打った文字で
 * 絞り、1件ずつ消せる。✕・Escape で閉じると打った文字を消す。探す（Enter・虫眼鏡）と、候補に番号を付け、デスクトップは押した行を選んで置くボタンを
 * 出し、スマホは下の札で1件ずつ見せて左右に送り、札のボタンで置く。
 *
 * ここで見ないもの:
 * - どの地点の役割で開くか・選んだ候補をその役割で置くこと・ブラウザの「戻る」で閉じること・探した候補を地図に番号の点で出し、
 *   点を押すとその候補を選ぶこと → `app/page.places.test.tsx`
 * - 選んだ候補を置いたあとに、置ける状態を解くこと → `features/route/useGenerationConditions.points.test.ts`
 * - スマホで「戻る」が検索だけを閉じてアプリから離れないこと・候補をキーボードの上の見える範囲に収めること（実際のブラウザの履歴と
 *   レイアウトの実寸） → `e2e/destination.spec.ts`
 * - 打ちかけの語の続きの候補・施設の候補とその並びを返すこと → backend の `tests/test_place_search_route.py`
 * - 保存した地点の一覧の読み方、履歴の上限・同じ位置の置き換え・保存した地点と同じ位置を出さないこと →
 *   `features/route/savedPlaces.test.ts`
 *
 * 差し替えたもの: 検索の口の応答（網の層）。保存した地点と履歴は本物の置き場（この端末の保存）を通す。
 */
import { act, fireEvent, screen, render, within } from "@testing-library/react";
import { createRef } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePlaceLookup } from "@/features/route/PlaceSearch/usePlaceLookup";
import { newPlacings, placeLabelOf } from "@/features/route/pointNames";
import type { SavedPlace } from "@/features/route/savedPlaces";
import { SAVED_PLACES_STORAGE_KEY, useSavedPlaces } from "@/features/route/useSavedPlaces";

import { onBackend } from "@/testing/backendServer";
import { AZA_CANDIDATE as AZA, FACILITY_CANDIDATE as FACILITY } from "@/testing/routeFixtures";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import type { Coordinates } from "@/types/route";

import PlaceSearch from "./PlaceSearch";

/** 地図の真ん中（東京駅）。丸の内二丁目まで直線で0.4km、浅草寺まで4.6km。 */
const TOKYO_STATION: Coordinates = { latitude: 35.681, longitude: 139.767 };
/** 浅草寺のすぐ南（浅草寺まで直線で0.2km）。 */
const NEAR_SENSOJI: Coordinates = { latitude: 35.713, longitude: 139.7967 };

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

/** 前に保存した地点を、この端末の保存へ置く。 */
function storeSavedPlaces(places: SavedPlace[]) {
  window.localStorage.setItem(SAVED_PLACES_STORAGE_KEY, JSON.stringify(places));
}

/** 欄の中身と候補の引き方・保存した地点は、ページと同じく包む側が持つ。 */
function Search({
  mapCenter,
  ...props
}: { mapCenter: Coordinates } & Omit<React.ComponentProps<typeof PlaceSearch>, "savedPlaces" | "lookup">) {
  return <PlaceSearch {...props} lookup={usePlaceLookup(mapCenter)} savedPlaces={useSavedPlaces()} />;
}

function renderSearch({ mapCenter = TOKYO_STATION, isMobile = false } = {}) {
  const onChoose = vi.fn();
  const onPlace = vi.fn();
  const inputRef = createRef<HTMLInputElement>();
  const search = (center: Coordinates) => (
    <Search
      title="目的地"
      chooseResult=""
      full={false}
      mapCenter={center}
      onChoose={onChoose}
      // 置く先のボタンは包む側が渡す（地点の並びの札は`app/page.places.test.tsx`が見る）。
      placeTo={(place) =>
        newPlacings({ waypointsFull: false, loop: false }).map(({ target }) => (
          <button key={target.role} type="button" onClick={() => place(target)}>
            {placeLabelOf(target)}
          </button>
        ))
      }
      onPlace={onPlace}
      onSearch={() => {}}
      isMobile={isMobile}
      cardIn="map"
      inputRef={inputRef}
    />
  );
  const { rerender } = render(search(mapCenter));
  return { onChoose, onPlace, moveMap: (center: Coordinates) => rerender(search(center)) };
}

function searchBox() {
  return screen.getByRole("searchbox", { name: "目的地を住所・施設で探す" });
}

/** 引いたときに送った地図の真ん中（クエリの値）。 */
function sentCenter(center: Coordinates) {
  return { latitude: String(center.latitude), longitude: String(center.longitude) };
}

/** 打つのが止まってから引くまでの間を、引かないことを確かめられるだけ待つ。 */
function waitPastLookUpDelay() {
  return new Promise((resolve) => setTimeout(resolve, routeGenerateConfig.place_prediction_delay_seconds * 1000 + 100));
}

async function searchFor(text: string) {
  await userEvent.clear(searchBox());
  await userEvent.type(searchBox(), `${text}{Enter}`);
}

describe("PlaceSearch 打つ欄", () => {
  it("探すとキーボードを閉じ、住所・施設の候補に番号と地図の真ん中からの距離（施設は辺りも）を付けて並べ、押した行を選んで置くボタンで上げる", async () => {
    const sent = onBackend("GET", "/api/place-search", () => Response.json({ candidates: [AZA, FACILITY] }));
    const { onPlace } = renderSearch();

    await searchFor(" 丸の内 ");

    const list = await screen.findByRole("list", { name: "地点の候補" });
    expect(searchBox()).not.toHaveFocus();
    expect(sent.map((request) => request.query)).toEqual([{ q: "丸の内", ...sentCenter(TOKYO_STATION) }]);
    const rows = () => within(list).getAllByRole("button", { name: /km/ });
    expect(rows().map((row) => row.textContent)).toEqual([
      `1${AZA.name}0.4km`,
      `2${FACILITY.name}${FACILITY.area}4.6km`,
    ]);
    // 先頭の候補を選んでいる。
    expect(rows().map((row) => row.getAttribute("aria-pressed"))).toEqual(["true", "false"]);

    await userEvent.click(rows()[1]);
    expect(rows().map((row) => row.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    await userEvent.click(within(list).getByRole("button", { name: "経由地に足す" }));
    expect(onPlace).toHaveBeenCalledExactlyOnceWith({ role: "waypoint", index: null }, FACILITY);
    expect(screen.queryByRole("list", { name: "地点の候補" })).toBeNull();
  });

  it("スマホでは探した候補を下の札で1件ずつ見せ、‹ ›か左右に払って送り、札のボタンで上げる", async () => {
    onBackend("GET", "/api/place-search", () => Response.json({ candidates: [AZA, FACILITY] }));
    const { onPlace } = renderSearch({ isMobile: true });

    await searchFor("丸の内");

    const card = await screen.findByRole("region", { name: "探した候補" });
    expect(screen.queryByRole("list", { name: "地点の候補" })).toBeNull();
    expect(card).toHaveTextContent(`1 / 2: ${AZA.name}0.4km`);
    expect(within(card).getByRole("button", { name: "前の候補" })).toBeDisabled();

    await userEvent.click(within(card).getByRole("button", { name: "次の候補" }));
    expect(card).toHaveTextContent(`2 / 2: ${FACILITY.name}`);
    expect(within(card).getByRole("button", { name: "次の候補" })).toBeDisabled();
    // 右へ払うと前の候補へ戻る。短い動きは送らない。
    fireEvent.pointerDown(card, { clientX: 100 });
    fireEvent.pointerUp(card, { clientX: 120 });
    expect(card).toHaveTextContent(`2 / 2: ${FACILITY.name}`);
    fireEvent.pointerDown(card, { clientX: 100 });
    fireEvent.pointerUp(card, { clientX: 200 });
    expect(card).toHaveTextContent(`1 / 2: ${AZA.name}`);

    await userEvent.click(within(card).getByRole("button", { name: "目的地にする" }));
    expect(onPlace).toHaveBeenCalledExactlyOnceWith({ role: "destination" }, AZA);
    expect(screen.queryByRole("region", { name: "探した候補" })).toBeNull();
  });

  it("打ちかけでも、決まった文字数から、打つのが止まると引く", async () => {
    const sent = onBackend("GET", "/api/place-search", () => Response.json({ candidates: [AZA] }));
    renderSearch();
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
    // 時計は打ち終えてから進める（本物の時計では、遅い機械で打鍵の間が引くまでの待ちを超え、打ちかけの文字で引く）。
    // `userEvent`は打つたびに本物の時計の`setTimeout`を待つので、偽の時計の下では打鍵を1字ずつ起こす。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sent = onBackend("GET", "/api/place-search", (request) =>
      Response.json({ candidates: request.query.q === "浅草寺" ? [FACILITY] : [AZA] }),
    );
    renderSearch();
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
    const list = await listed();
    expect(within(list).getByRole("button")).toHaveTextContent(FACILITY.name);
    expect(sent.map((request) => request.query.q)).toEqual(["丸の内", "浅草寺"]);
  });

  it("かな漢字の変換中は引かず、確定してから引く", async () => {
    const sent = onBackend("GET", "/api/place-search", () => Response.json({ candidates: [AZA] }));
    renderSearch();
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

  it("引いたときの地図の真ん中から並べて距離を出し、引いたあとに地図を動かしても引き直さず、虫眼鏡を押すとその地図の真ん中で引き直す", async () => {
    const sent = onBackend("GET", "/api/place-search", () => Response.json({ candidates: [FACILITY] }));
    const { moveMap } = renderSearch();

    moveMap(NEAR_SENSOJI);
    await searchFor("浅草寺");
    const list = await screen.findByRole("list", { name: "地点の候補" });

    moveMap(TOKYO_STATION);
    await waitPastLookUpDelay();
    expect(sent.map((request) => request.query)).toEqual([{ q: "浅草寺", ...sentCenter(NEAR_SENSOJI) }]);
    expect(within(list).getByRole("button", { name: /km/ })).toHaveTextContent(`${FACILITY.name}${FACILITY.area}0.2km`);

    await userEvent.click(screen.getByRole("button", { name: "探す" }));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].query).toEqual({ q: "浅草寺", ...sentCenter(TOKYO_STATION) });
    expect(searchBox()).not.toHaveFocus();
  });

  it("同じ文字・同じ地図の真ん中で押し直すと引き直す（地図が動いて真ん中を作り直しても、位置が同じなら同じ真ん中）", async () => {
    const sent = onBackend("GET", "/api/place-search", () => Response.json({ candidates: [FACILITY] }));
    const { moveMap } = renderSearch();
    await searchFor("浅草寺");
    await screen.findByRole("list", { name: "地点の候補" });

    moveMap({ ...TOKYO_STATION });
    await userEvent.type(searchBox(), "{Enter}");

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].query).toEqual({ q: "浅草寺", ...sentCenter(TOKYO_STATION) });
  });

  it("当たらなければそう出し、検索が使えなければ口の文を出す", async () => {
    onBackend("GET", "/api/place-search", () => Response.json({ candidates: [] }));
    renderSearch();

    await searchFor("どこにもない");
    expect(await screen.findByRole("status")).toHaveTextContent("当たる住所・施設がありません。");

    onBackend("GET", "/api/place-search", () =>
      Response.json({ detail: "対象範囲を読めませんでした" }, { status: 502 }),
    );
    await searchFor("丸の内");
    expect(await screen.findByRole("alert")).toHaveTextContent("対象範囲を読めませんでした");
  });
  it.each([
    ["✕", () => userEvent.click(screen.getByRole("button", { name: "目的地の候補を閉じる" }))],
    ["Escape", () => userEvent.keyboard("{Escape}")],
  ])("%sで閉じると、候補の一覧を閉じて打った文字を消し、選ばない", async (_, closeSearch) => {
    onBackend("GET", "/api/place-search", () => Response.json({ candidates: [AZA] }));
    const { onChoose, onPlace } = renderSearch();
    await searchFor("丸の内");
    await screen.findByRole("list", { name: "地点の候補" });

    await closeSearch();

    expect(screen.queryByRole("list", { name: "地点の候補" })).toBeNull();
    expect(searchBox()).toHaveValue("");
    expect(searchBox()).not.toHaveFocus();
    expect(onChoose).not.toHaveBeenCalled();
    expect(onPlace).not.toHaveBeenCalled();
  });
});

describe("PlaceSearch 保存した地点", () => {
  const CAFE: SavedPlace = { ...FACILITY, name: "いつものカフェ" };
  const HOME: SavedPlace = { kind: "facility", level: "point", name: "自宅", area: null, ...NEAR_SENSOJI };

  it("打つ欄を押すと保存した地点を出し、打った文字を名前に含むものに絞り、選んだ地点を上げて一覧を閉じる", async () => {
    storeSavedPlaces([CAFE, HOME]);
    const { onChoose } = renderSearch();

    await userEvent.click(searchBox());
    const saved = () => screen.getByRole("list", { name: "保存した地点" });
    expect(
      within(saved())
        .getAllByRole("button")
        .map((row) => row.textContent),
    ).toEqual([`${CAFE.name}${CAFE.area}`, HOME.name]);

    await userEvent.type(searchBox(), "自");
    expect(within(saved()).getAllByRole("button")).toHaveLength(1);
    await userEvent.click(within(saved()).getByRole("button", { name: /自宅/ }));

    expect(onChoose).toHaveBeenCalledExactlyOnceWith(HOME);
    expect(screen.queryByRole("list", { name: "保存した地点" })).toBeNull();
    expect(searchBox()).toHaveValue("");
  });
});

describe("PlaceSearch 検索の履歴", () => {
  const history = () => screen.getByRole("list", { name: "検索の履歴" });
  const rows = () =>
    within(history())
      .getAllByRole("button", { name: /^(?!.*履歴から消す)/ })
      .map((row) => row.textContent);

  it("選んだ候補を次に欄を押したとき新しい順に出し、選ぶとその地点を上げ、打った文字で絞り、1件ずつ消せる", async () => {
    onBackend("GET", "/api/place-search", (request) =>
      Response.json({ candidates: request.query.q === "浅草寺" ? [FACILITY] : [AZA] }),
    );
    const { onChoose } = renderSearch();
    for (const text of ["丸の内", "浅草寺"]) {
      await searchFor(text);
      const list = await screen.findByRole("list", { name: "地点の候補" });
      await userEvent.click(within(list).getByRole("button", { name: "目的地にする" }));
    }

    await userEvent.click(searchBox());
    expect(rows()).toEqual([`${FACILITY.name}${FACILITY.area}`, AZA.name]);

    await userEvent.click(within(history()).getByRole("button", { name: AZA.name }));
    expect(onChoose).toHaveBeenLastCalledWith(AZA);

    await userEvent.click(searchBox());
    expect(rows()).toEqual([AZA.name, `${FACILITY.name}${FACILITY.area}`]);
    await userEvent.type(searchBox(), "浅草");
    expect(rows()).toEqual([`${FACILITY.name}${FACILITY.area}`]);

    await userEvent.click(screen.getByRole("button", { name: `${FACILITY.name}を履歴から消す` }));
    await userEvent.clear(searchBox());
    expect(rows()).toEqual([AZA.name]);
  });

  it("保存した地点を選んでも履歴に残さない", async () => {
    storeSavedPlaces([{ ...FACILITY, name: "いつものカフェ" }]);
    renderSearch();

    await userEvent.click(searchBox());
    await userEvent.click(within(screen.getByRole("list", { name: "保存した地点" })).getByRole("button"));
    await userEvent.click(searchBox());

    expect(screen.queryByRole("list", { name: "検索の履歴" })).toBeNull();
  });
});
