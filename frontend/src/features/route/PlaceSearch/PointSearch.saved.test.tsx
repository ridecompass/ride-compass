/**
 * `PlaceSearch/PointSearch.tsx`——地点を探す小窓の、打つ前に出す保存した地点と検索の履歴と、候補の☆での保存。開くと保存した地点を出し、
 * 打った文字を名前に含むものに絞り、選んだ地点を置く。住所・施設の候補か履歴を選ぶと履歴に残し、次に開くと保存した地点の下に
 * 新しい順に出し、打った文字で絞り、1件ずつ消せる。保存した地点も行の ✕ でその場で保存をやめられる。候補の☆はその候補を名前のまま保存し、もう一度押すと保存をやめる。置いている地点の
 * 保存のチップは、探して置いた地点をその候補のまま、地図で置いた地点を辺りを名前にして保存する。地点の行の☆は、欄を出さずに保存した地点と
 * いまの地点の保存のチップだけの小窓を開き、保存が無く地点も置いていなければ押せない。
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
import { openPointSearch, renderForm, waypointsOf } from "@/testing/routeForm";

beforeEach(() => {
  window.localStorage.clear();
  onBackend("GET", "/api/place-area", () => Response.json({ area: null }));
  serveClientConfig();
});

/** 一覧の地点の行（右の ✕ は名前を「」で囲むので除く）。 */
function placeRows(list: HTMLElement) {
  return within(list).getAllByRole("button", { name: /^(?!「)/ });
}

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
    expect(placeRows(saved()).map((row) => row.textContent)).toEqual([`${CAFE.name}${CAFE.area}`, HOME.name]);

    await userEvent.type(searchBox(), "自");
    expect(placeRows(saved())).toHaveLength(1);
    await userEvent.click(within(saved()).getByRole("button", { name: HOME.name }));

    expect(onPlace).toHaveBeenCalledExactlyOnceWith({ role: "destination" }, HOME);
    expect(screen.queryByRole("dialog", { name: "目的地を探す" })).toBeNull();
  });

  it("行の ✕ で、小窓を開いたままその地点の保存をやめる", async () => {
    storeSavedPlaces([CAFE, HOME]);
    const { onPlace } = await renderSearch();

    await userEvent.click(screen.getByRole("button", { name: `「${CAFE.name}」の保存をやめる` }));

    expect(placeRows(screen.getByRole("list", { name: "保存した地点" })).map((row) => row.textContent)).toEqual([
      HOME.name,
    ]);
    expect(JSON.parse(window.localStorage.getItem(SAVED_PLACES_STORAGE_KEY) ?? "[]")).toEqual([HOME]);
    expect(onPlace).not.toHaveBeenCalled();
  });

  it("地点の行の☆は、欄と履歴を出さずに保存した地点だけの小窓を開き、選んだ地点をその行に置いて閉じる", async () => {
    storeSavedPlaces([CAFE, HOME]);
    const { onPlace } = renderForm({ waypoints: waypointsOf(1) });

    await userEvent.click(screen.getByRole("button", { name: "経由地1を保存した地点から選ぶ" }));
    const picker = screen.getByRole("dialog", { name: "経由地1を保存した地点から選ぶ" });
    expect(within(picker).queryByRole("searchbox")).toBeNull();
    expect(within(picker).queryByRole("list", { name: "検索の履歴" })).toBeNull();
    await userEvent.click(within(picker).getByRole("button", { name: HOME.name }));

    expect(onPlace).toHaveBeenCalledExactlyOnceWith({ role: "waypoint", index: 0 }, HOME);
    expect(screen.queryByRole("dialog", { name: "経由地1を保存した地点から選ぶ" })).toBeNull();
  });

  it("地点の行の☆から開いた小窓を閉じると、フォーカスは押した☆へ戻る", async () => {
    storeSavedPlaces([HOME]);
    renderForm({ waypoints: waypointsOf(1) });
    const star = screen.getByRole("button", { name: "経由地1を保存した地点から選ぶ" });
    star.focus();

    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "経由地1を保存した地点から選ぶ" })).toBeNull();
    expect(star).toHaveFocus();
  });

  it("保存した地点が無く、地点も置いていない行の☆は押せない", () => {
    renderForm();

    expect(screen.getByRole("button", { name: "目的地を保存した地点から選ぶ" })).toBeDisabled();
  });

  it("地点を置いた行の☆は保存した地点が無くても押せ、開いた小窓の☆と名前でその地点を保存し、もう一度押すと保存をやめる", async () => {
    renderForm({
      destination: FACILITY,
      foundAt: (point) => (point?.latitude === FACILITY.latitude ? FACILITY : null),
    });
    await screen.findByRole("button", { name: `目的地 ${FACILITY.name}` });

    await userEvent.click(screen.getByRole("button", { name: "目的地を保存した地点から選ぶ" }));
    const picker = screen.getByRole("dialog", { name: "目的地を保存した地点から選ぶ" });
    const save = within(picker).getByRole("button", { name: `「${FACILITY.name}」を保存` });
    await userEvent.click(save);

    expect(save).toHaveAttribute("aria-pressed", "true");
    expect(JSON.parse(window.localStorage.getItem(SAVED_PLACES_STORAGE_KEY) ?? "[]")).toEqual([FACILITY]);
    expect(within(picker).getByRole("list", { name: "保存した地点" })).toBeInTheDocument();

    await userEvent.click(save);
    expect(save).toHaveAttribute("aria-pressed", "false");
    expect(JSON.parse(window.localStorage.getItem(SAVED_PLACES_STORAGE_KEY) ?? "[]")).toEqual([]);
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
    expect(placeRows(screen.getByRole("list", { name: "保存した地点" })).map((row) => row.textContent)).toEqual([
      `${FACILITY.name}${FACILITY.area}`,
    ]);

    await searchFor("浅草寺");
    const again = await screen.findByRole("list", { name: "地点の候補" });
    await userEvent.click(within(again).getByRole("button", { name: `「${FACILITY.name}」の保存をやめる` }));
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
  const rows = () => placeRows(history()).map((row) => row.textContent);

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

    await userEvent.click(screen.getByRole("button", { name: `「${FACILITY.name}」を履歴から消す` }));
    await userEvent.clear(searchBox());
    expect(rows()).toEqual([AZA.name]);
  });

  it("保存した地点を選んでも履歴に残さない", async () => {
    storeSavedPlaces([{ ...FACILITY, name: "いつものカフェ" }]);
    await renderSearch();

    await userEvent.click(placeRows(screen.getByRole("list", { name: "保存した地点" }))[0]);
    await openPointSearch("目的地");

    expect(screen.queryByRole("list", { name: "検索の履歴" })).toBeNull();
  });
});
