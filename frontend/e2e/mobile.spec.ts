import { expect, test } from "@playwright/test";
import {
  MOBILE_VIEWPORT,
  doneJobFixture,
  openMobileApp,
  openMobileSheet,
  routeGenerateResponseFixture,
  setDistance,
} from "./fixtures";

// モバイル（390px）で、要素が幅に収まり押せること（パターン4 観点1）。要素は画面外へ
// 出てもアクセシビリティツリーに残るため、役割・名前では捕まらない。幅と座標を実測する。

test("モバイル: 観測値の取得に失敗してもヘッダーが幅に収まり、メニューが押せる", async ({ page }) => {
  await openMobileApp(page, {
    routes: (page) =>
      page.route("**/api/weather/amedas*", (route) =>
        route.fulfill({ status: 503, json: { detail: "アメダス観測値の取得に失敗しました" } }),
      ),
  });

  await expect(page.getByRole("img", { name: "観測値を取得できません" })).toBeVisible();

  const header = page.locator("header").first();
  const size = await header.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(size.scrollWidth).toBeLessThanOrEqual(size.clientWidth);

  const menu = await page.getByRole("button", { name: "メニュー" }).boundingBox();
  expect(menu).not.toBeNull();
  expect((menu?.x ?? 0) + (menu?.width ?? 0)).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
});

/** 候補0件の理由。1行に収まらない長さにして、折り返した全体が見えるかを見る（本番の文は使わない）。 */
const LONG_NO_CANDIDATES_REASON =
  "出発地の近くに、条件に合う道路がありませんでした。距離を変えるか、除外した道路の種類を減らしてから試してください。";

// 観点1（収まる・押せる）: 押した「生成」が候補を出せなかった理由の窓は、開いているシートより前に、長い文でも画面に収まって
// 出て、閉じられる。窓の中の文はアクセシビリティツリーでは見えていても、重なり順で隠れうるので座標で見る。
test("モバイル: 候補0件の理由の窓が、開いている「ルート設定」より前に画面に収まって出て、閉じられる", async ({
  page,
}) => {
  await openMobileApp(page, {
    routes: (page) =>
      page.route("**/api/routes/generate/*", (route) =>
        route.fulfill({
          json: doneJobFixture({
            ...routeGenerateResponseFixture(),
            routes: [],
            no_candidates_reason: LONG_NO_CANDIDATES_REASON,
          }),
        }),
      ),
  });
  const sheet = await openMobileSheet(page, "ルート設定");
  await setDistance(sheet, 20);
  await sheet.getByRole("button", { name: "ルート生成" }).click();
  const notice = page.getByRole("dialog", { name: "候補が見つかりませんでした" });
  const reason = notice.getByText(LONG_NO_CANDIDATES_REASON);
  await expect(reason).toBeVisible();

  const placement = await reason.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      withinWidth: box.left >= 0 && box.right <= window.innerWidth && el.scrollWidth <= el.clientWidth,
      withinHeight: box.top >= 0 && box.bottom <= window.innerHeight,
      onTop: hit !== null && el.contains(hit),
    };
  });
  expect(placement).toEqual({ withinWidth: true, withinHeight: true, onTop: true });

  await notice.getByRole("button", { name: "閉じる" }).click();
  await expect(notice).toBeHidden();
});

// 観点1（収まる）: 「保存済み」タブの「設定」の一覧は、何も知らせていない間、上に空白を作らず「地点」の一覧と同じ高さから
// 始まる。知らせの行は読み上げのために置いたままなので、場所を取るかは実寸でしか見えない。
test("モバイル: 「保存済み」の「設定」の一覧は、「地点」の一覧と同じ高さから始まる", async ({ page }) => {
  await openMobileApp(page, {
    storedState: {
      "ridecompass:saved-places": JSON.stringify([
        { kind: "address", level: "block", name: "自宅", area: null, latitude: 37.4, longitude: 140.4 },
      ]),
      "ridecompass:saved-conditions": JSON.stringify([
        {
          name: "いつもの周回",
          loop: true,
          distanceTargeted: true,
          distance: "40",
          maxRoutes: "3",
          origin: null,
          waypoints: [],
          destination: null,
          costPreference: { strength: 1, multipliers: {}, disabled_axes: [] },
          roadAvoidance: {},
        },
      ]),
    },
  });
  const sheet = await openMobileSheet(page, "ルート設定");
  await sheet.getByRole("tab", { name: "保存済み" }).click();

  const firstRowTop = async (tab: string) => {
    await sheet.getByRole("tab", { name: tab, exact: true }).click();
    const row = sheet.getByRole("tabpanel", { name: tab, exact: true }).getByRole("listitem").first();
    await expect(row).toBeVisible();
    return (await row.boundingBox())!.y;
  };
  expect(await firstRowTop("設定")).toBe(await firstRowTop("地点"));
});
