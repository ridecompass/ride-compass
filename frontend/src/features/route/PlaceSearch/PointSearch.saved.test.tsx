/**
 * `PlaceSearch/PointSearch.tsx`——地点を探す小窓の、打つ前に出す保存した地点と検索の履歴と、候補の☆での保存。開くと保存した地点を出し、
 * 打った文字を名前に含むものに絞り、選んだ地点を置く。住所・施設の候補か履歴を選ぶと履歴に残し、次に開くと保存した地点の下に
 * 新しい順に出し、打った文字で絞り、1件ずつ消せる。候補の☆はその候補を名前のまま保存し、もう一度押すと保存をやめる。置いている地点の
 * 保存のチップは、探して置いた地点をその候補のまま、地図で置いた地点を辺りを名前にして保存する。
 *
 * ここで見ないもの:
 * - 打つ欄で引く・候補を並べる・選ぶこと → `PlaceSearch/PointSearch.test.tsx`
 * - 保存した地点の一覧の読み方、履歴の上限・同じ位置の置き換え・保存した地点と同じ位置を出さないこと →
 *   `features/route/savedPlaces.test.ts`
 *
 * 差し替えたもの: 検索の口と辺りの口の応答（網の層）。保存した地点と履歴は本物の置き場（この端末の保存）を通す。
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { SavedPlace } from "@/features/route/savedPlaces";
import { SAVED_PLACES_STORAGE_KEY } from "@/features/route/useSavedPlaces";

import { onBackend, serveClientConfig } from "@/testing/backendServer";
import { NEAR_SENSOJI, renderSearch, searchBox, searchFor } from "@/testing/placeSearch";
import { AZA_CANDIDATE as AZA, FACILITY_CANDIDATE as FACILITY } from "@/testing/routeFixtures";
import { openPointSearch, renderForm } from "@/testing/routeForm";

beforeEach(() => {
  window.localStorage.clear();
  onBackend("GET", "/api/place-area", () => Response.json({ area: null }));
  serveClientConfig();
});

/** 前に保存した地点を、この端末の保存へ置く。 */
function storeSavedPlaces(places: SavedPlace[]) {
  window.localStorage.setItem(SAVED_PLACES_STORAGE_KEY, JSON.stringify(places));
}

describe("PointSearch 保存した地点", () => {
  const CAFE: SavedPlace = { ...FACILITY, name: "いつものカフェ" };
  const HOME: SavedPlace = { kind: "facility", level: "point", name: "自宅", area: null, ...NEAR_SENSOJI };

  it("開くと保存した地点を出し、打った文字を名前に含むものに絞り、選んだ地点を置いて閉じる", async () => {
    storeSavedPlaces([CAFE, HOME]);
    const { onPlace } = await renderSearch();

    const saved = () => screen.getByRole("list", { name: "保存した地点" });
    expect(
      within(saved())
        .getAllByRole("button")
        .map((row) => row.textContent),
    ).toEqual([`${CAFE.name}${CAFE.area}`, HOME.name]);

    await userEvent.type(searchBox(), "自");
    expect(within(saved()).getAllByRole("button")).toHaveLength(1);
    await userEvent.click(within(saved()).getByRole("button", { name: /自宅/ }));

    expect(onPlace).toHaveBeenCalledExactlyOnceWith({ role: "destination" }, HOME);
    expect(screen.queryByRole("dialog", { name: "目的地を探す" })).toBeNull();
  });

  it("候補の☆でその候補を名前のまま保存し、もう一度押すと保存をやめる", async () => {
    onBackend("GET", "/api/place-search", () => Response.json({ candidates: [FACILITY] }));
    await renderSearch();
    await searchFor("浅草寺");
    const list = await screen.findByRole("list", { name: "地点の候補" });

    await userEvent.click(within(list).getByRole("button", { name: `「${FACILITY.name}」を保存` }));
    const unsave = within(list).getByRole("button", { name: `「${FACILITY.name}」の保存をやめる` });
    expect(unsave).toHaveAttribute("aria-pressed", "true");
    await userEvent.clear(searchBox());
    expect(within(screen.getByRole("list", { name: "保存した地点" })).getByRole("button")).toHaveTextContent(
      FACILITY.name,
    );

    await searchFor("浅草寺");
    await userEvent.click(await screen.findByRole("button", { name: `「${FACILITY.name}」の保存をやめる` }));
    await userEvent.clear(searchBox());
    expect(screen.queryByRole("list", { name: "保存した地点" })).toBeNull();
  });

  it.each([
    { label: "探して置いた地点はその候補のまま", found: true, area: null, saved: FACILITY },
    {
      label: "地図で置いた地点は辺りを名前と辺りにして",
      found: false,
      area: "台東区浅草",
      saved: { kind: "facility", level: "point", name: "台東区浅草", area: "台東区浅草", ...NEAR_SENSOJI },
    },
  ] as const)("置いている地点の保存のチップで保存する: $label", async ({ found, area, saved }) => {
    onBackend("GET", "/api/place-area", () => Response.json({ area }));
    const at = found ? FACILITY : NEAR_SENSOJI;
    renderForm({ destination: at, foundAt: (point) => (found && point?.latitude === at.latitude ? FACILITY : null) });
    await screen.findByRole("button", { name: `目的地 ${saved.name}` });
    await openPointSearch(`目的地 ${saved.name}`, "目的地");

    await userEvent.click(screen.getByRole("button", { name: /を保存$/ }));

    expect(JSON.parse(window.localStorage.getItem(SAVED_PLACES_STORAGE_KEY) ?? "[]")).toEqual([saved]);
  });
});

describe("PointSearch 検索の履歴", () => {
  const history = () => screen.getByRole("list", { name: "検索の履歴" });
  const rows = () =>
    within(history())
      .getAllByRole("button", { name: /^(?!.*履歴から消す)/ })
      .map((row) => row.textContent);

  it("選んだ候補を次に開いたとき新しい順に出し、選ぶとその地点を置き、打った文字で絞り、1件ずつ消せる", async () => {
    onBackend("GET", "/api/place-search", (request) =>
      Response.json({ candidates: request.query.q === "浅草寺" ? [FACILITY] : [AZA] }),
    );
    const { onPlace } = await renderSearch();
    for (const [text, place] of [
      ["丸の内", AZA],
      ["浅草寺", FACILITY],
    ] as const) {
      if (screen.queryByRole("dialog", { name: "目的地を探す" }) === null) await openPointSearch("目的地");
      await searchFor(text);
      const list = await screen.findByRole("list", { name: "地点の候補" });
      await userEvent.click(within(list).getByRole("button", { name: new RegExp(`^${place.name}`) }));
    }

    await openPointSearch("目的地");
    expect(rows()).toEqual([`${FACILITY.name}${FACILITY.area}`, AZA.name]);

    await userEvent.click(within(history()).getByRole("button", { name: AZA.name }));
    expect(onPlace).toHaveBeenLastCalledWith({ role: "destination" }, AZA);

    await openPointSearch("目的地");
    expect(rows()).toEqual([AZA.name, `${FACILITY.name}${FACILITY.area}`]);
    await userEvent.type(searchBox(), "浅草");
    expect(rows()).toEqual([`${FACILITY.name}${FACILITY.area}`]);

    await userEvent.click(screen.getByRole("button", { name: `${FACILITY.name}を履歴から消す` }));
    await userEvent.clear(searchBox());
    expect(rows()).toEqual([AZA.name]);
  });

  it("保存した地点を選んでも履歴に残さない", async () => {
    storeSavedPlaces([{ ...FACILITY, name: "いつものカフェ" }]);
    await renderSearch();

    await userEvent.click(within(screen.getByRole("list", { name: "保存した地点" })).getByRole("button"));
    await openPointSearch("目的地");

    expect(screen.queryByRole("list", { name: "検索の履歴" })).toBeNull();
  });
});
