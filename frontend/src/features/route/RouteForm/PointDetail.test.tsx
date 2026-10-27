/**
 * `RouteForm/PointDetail.tsx`——押した地点の詳しく。探して置いた地点の辺りと、代表の位置にすぎないことを出す。地図で選んだ地点と
 * 辺りの無い施設には、位置から引いた辺りを出す（探した住所には引かない）。置いた地点を名前を付けて保存し、保存した地点なら保存を
 * やめられる。
 *
 * ここで見ないもの:
 * - 住所・施設で探す欄とその候補・保存した地点の候補 → `PlaceSearch/PlaceSearchBar.test.tsx`。探すボタンで欄を開くこと →
 *   `app/page.places.test.tsx`
 * - 地点ごとの呼び名・出どころ・名前・探すボタンの文言・消す・「現在地に戻す」・上限 → `RouteForm/RouteForm.pointDetail.test.tsx`
 * - 置いた地点へ地図を寄せること・地図の上でピンを動かすこと → `e2e/destination.spec.ts`
 * - 位置の辺りの決め方 → backend の `tests/test_place_search_route.py`
 * - 出発地・経由地・目的地のどの位置を渡すか（現在地を取れていない出発地は渡さない） → `RouteForm/RouteForm.pointDetail.test.tsx`
 * - 保存した地点の一覧の読み方・同じ名前と位置の置き換え → `features/route/savedPlaces.test.ts`
 *
 * 差し替えたもの: 辺りの口の応答（網の層）。保存した地点は本物の置き場（この端末の保存）を通す。
 */
import { screen, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SavedPlace } from "@/features/route/savedPlaces";
import { useSavedPlaces } from "@/features/route/useSavedPlaces";

import { onBackend } from "@/testing/backendServer";
import { AZA_CANDIDATE as AZA, FACILITY_CANDIDATE as FACILITY } from "@/testing/routeFixtures";
import type { Coordinates, PlaceCandidate } from "@/types/route";

import PointDetail from "./PointDetail";

const BLOCK: PlaceCandidate = {
  kind: "address",
  level: "block",
  name: "東京都千代田区丸の内一丁目9番",
  area: null,
  latitude: 35.681,
  longitude: 139.767,
};

/** 浅草寺のすぐ南。 */
const NEAR_SENSOJI: Coordinates = { latitude: 35.713, longitude: 139.7967 };

beforeEach(() => {
  window.localStorage.clear();
});

function WithSavedPlaces(props: Omit<React.ComponentProps<typeof PointDetail>, "savedPlaces">) {
  return <PointDetail {...props} savedPlaces={useSavedPlaces()} />;
}

function renderDetail({ found = null as PlaceCandidate | null, at = null as Coordinates | null } = {}) {
  render(
    <WithSavedPlaces
      role="destination"
      title="目的地"
      name={found?.name ?? "未設定"}
      found={found}
      at={at}
      placed={found !== null}
      placing={false}
      originLocated
      onSearchOpen={vi.fn()}
    />,
  );
}

describe("PointDetail 置いた地点", () => {
  it.each([
    ["施設", FACILITY, `${FACILITY.name}${FACILITY.area}`, false],
    ["区画で当たった住所", AZA, `${AZA.name}代表の位置`, true],
    ["街区・地番まで当たった住所", BLOCK, BLOCK.name, false],
  ])(
    "探して置いた%sは、名前に施設の辺りを添え、区画で当たった住所には代表の位置と出す",
    (_kind, found, text, representative) => {
      // 辺りの口へ問い合わせない（応答を与えていない要求はテストを落とす）。
      renderDetail({ found, at: { latitude: found.latitude, longitude: found.longitude } });

      const detail = screen.getByRole("region", { name: "目的地" });
      expect(detail.textContent).toContain(`目的地${text}`);
      expect(within(detail).queryByText("代表の位置") !== null).toBe(representative);
    },
  );

  it.each([
    ["地図で選んだ地点", null, "目的地未設定"],
    ["辺りの無い施設", { ...FACILITY, area: null }, `目的地${FACILITY.name}`],
  ])("%sには、位置から引いた辺りを出す", async (_kind, found, head) => {
    const sent = onBackend("GET", "/api/place-area", () => Response.json({ area: "台東区浅草二丁目" }));
    renderDetail({ found, at: NEAR_SENSOJI });

    const detail = screen.getByRole("region", { name: "目的地" });
    expect(await within(detail).findByText("台東区浅草二丁目")).toBeDefined();
    expect(detail.textContent).toContain(`${head}台東区浅草二丁目`);
    expect(sent.map(({ query }) => query)).toEqual([
      { latitude: String(NEAR_SENSOJI.latitude), longitude: String(NEAR_SENSOJI.longitude) },
    ]);
  });
});

describe("PointDetail 保存した地点", () => {
  const CAFE: SavedPlace = { ...FACILITY, name: "いつものカフェ" };

  it("置いた地点は、探した候補の名前を入れた窓で名前を付けて保存し、保存した地点なら保存をやめられる", async () => {
    renderDetail({ found: FACILITY, at: { latitude: FACILITY.latitude, longitude: FACILITY.longitude } });

    await userEvent.click(screen.getByRole("button", { name: "地点を保存" }));
    const dialog = screen.getByRole("dialog", { name: "地点を保存" });
    const nameInput = within(dialog).getByRole("textbox", { name: "保存する地点の名前" });
    expect(nameInput).toHaveValue(FACILITY.name);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, CAFE.name);
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await userEvent.click(screen.getByRole("button", { name: `「${CAFE.name}」の保存をやめる` }));
    expect(screen.getByRole("button", { name: "地点を保存" })).toBeInTheDocument();
  });

  it("置いていない地点は、保存の操作を押せなくしておく", () => {
    renderDetail();

    expect(screen.getByRole("button", { name: "地点を保存" })).toBeDisabled();
  });
});
