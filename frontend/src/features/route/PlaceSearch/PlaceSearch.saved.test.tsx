/**
 * `PlaceSearch/PlaceSearch.tsx`——地点を探す欄の、打つ欄を押したときに出す保存した地点と検索の履歴。打つ欄を押すと保存した地点を出し、
 * 打った文字を名前に含むものに絞り、選んだ地点を上げる。住所・施設の候補か履歴を選ぶと履歴に残し、次に欄を押すと保存した地点の下に
 * 新しい順に出し、打った文字で絞り、1件ずつ消せる。
 *
 * ここで見ないもの:
 * - 打つ欄で引く・候補を並べる・選ぶこと → `PlaceSearch/PlaceSearch.test.tsx`
 * - 保存した地点の一覧の読み方、履歴の上限・同じ位置の置き換え・保存した地点と同じ位置を出さないこと →
 *   `features/route/savedPlaces.test.ts`
 *
 * 差し替えたもの: 検索の口の応答（網の層）。保存した地点と履歴は本物の置き場（この端末の保存）を通す。
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { SavedPlace } from "@/features/route/savedPlaces";
import { SAVED_PLACES_STORAGE_KEY } from "@/features/route/useSavedPlaces";

import { onBackend } from "@/testing/backendServer";
import { NEAR_SENSOJI, renderSearch, searchBox, searchFor } from "@/testing/placeSearch";
import { AZA_CANDIDATE as AZA, FACILITY_CANDIDATE as FACILITY } from "@/testing/routeFixtures";

beforeEach(() => {
  window.localStorage.clear();
});

/** 前に保存した地点を、この端末の保存へ置く。 */
function storeSavedPlaces(places: SavedPlace[]) {
  window.localStorage.setItem(SAVED_PLACES_STORAGE_KEY, JSON.stringify(places));
}

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
