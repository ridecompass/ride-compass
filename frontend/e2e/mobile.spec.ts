import { expect, test } from "@playwright/test";
import { catalogEntry } from "@/testing/catalogAxes";
import {
  MOBILE_VIEWPORT,
  axisCatalogFixture,
  doneJobFixture,
  generateRoutes,
  installMapFinder,
  openMobileApp,
  openMobileSheet,
  routeGenerateResponseFixture,
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

  // 一般画面にはリクエストIDを含む長い文言を出さない。
  await expect(page.getByText("観測値を取得できません")).toBeVisible();
  await expect(page.getByText(/\[req:/)).toHaveCount(0);

  const header = page.locator("header").first();
  const size = await header.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(size.scrollWidth).toBeLessThanOrEqual(size.clientWidth);

  const menu = await page.getByRole("button", { name: "メニュー" }).boundingBox();
  expect(menu).not.toBeNull();
  expect((menu?.x ?? 0) + (menu?.width ?? 0)).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
});

/** 段階が細かく、凡例の1行（「とても少ない（0.125〜0.375箇所/km）」）が長くなる軸。
 * 本番の軸名・値は使わない。 */
const FINE_STEP_AXIS_LABEL = "段階の細かい軸";

// レンズの凡例は段階の細かい軸ほど1行が長い。グリッドのセルに収まらないと、値の右側が読めなくなる。
test("モバイル: レンズの凡例が、段階の細かい軸でも幅に収まる", async ({ page }) => {
  await openMobileApp(page, {
    routes: (page) =>
      page.route("**/api/axis-catalog*", (route) =>
        route.fulfill({
          json: axisCatalogFixture([
            {
              ...catalogEntry({
                axis_id: "fine_steps",
                label: FINE_STEP_AXIS_LABEL,
                raw_value_units: { unit: "箇所/km" },
                map_paint: {
                  band_labels: [
                    "ほとんど無い",
                    "とても少ない",
                    "かなり少ない",
                    "やや少ない",
                    "ふつう",
                    "やや多い",
                    "かなり多い",
                    "とても多い",
                    "非常に多い",
                  ],
                  thresholds: [0.125, 0.375, 0.625, 0.875, 1.125, 1.375, 1.625, 1.875],
                },
              }),
              default_weight: 0,
            },
          ]),
        }),
      ),
  });

  await page.getByRole("button", { name: /^評価で塗る:/ }).click();
  await page.getByRole("radio", { name: FINE_STEP_AXIS_LABEL }).click();
  await page.getByRole("button", { name: `${FINE_STEP_AXIS_LABEL}の凡例` }).click();
  await expect(page.getByLabel("凡例の全段階をまとめて表示/非表示")).toBeVisible();

  const rows = await page.evaluate(() => {
    const header = [...document.querySelectorAll("label")].find((el) => el.textContent?.trim() === "凡例");
    const list = header?.parentElement?.lastElementChild;
    return [...((list?.children ?? []) as HTMLCollectionOf<HTMLElement>)].map((row) => ({
      label: row.textContent?.trim() ?? "",
      overflowPx: row.scrollWidth - row.clientWidth,
      beyondViewportPx: Math.round(row.getBoundingClientRect().right - window.innerWidth),
    }));
  });

  expect(rows.length).toBeGreaterThan(0);
  expect(rows.filter((row) => row.overflowPx > 0 || row.beyondViewportPx > 0)).toEqual([]);
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
  await sheet.getByLabel("全長の目標", { exact: true }).fill("20");
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

// 観点1（収まる）: 生成したルートを地図へ収めると、開いた「ルート結果」のシートに隠れず、その上の見えている所に描かれる。
// 地図がどこまで覆われているかは実寸でしか決まらない（シートの高さは中身に合わせて決まる）。
// ルートは南北に長くする。東西に長いと幅で倍率が決まり、覆う物を避けなくても地図の中ほどの細い帯に収まってしまう。
const NORTH_SOUTH_ROUTE: [number, number][] = [
  [139.7387, 35.74],
  [139.74, 35.78],
  [139.7387, 35.74],
];

test("モバイル: 生成したルートを地図へ収めると、開いた「ルート結果」のシートの上に描かれる", async ({ page }) => {
  const generated = routeGenerateResponseFixture();
  const routes = generated.routes.map((route) => ({
    ...route,
    geometry: { type: "LineString" as const, coordinates: NORTH_SOUTH_ROUTE },
  }));
  await page.addInitScript(installMapFinder);
  await openMobileApp(page, {
    routes: (page) =>
      page.route("**/api/routes/generate/*", (route) =>
        route.fulfill({ json: doneJobFixture({ ...generated, routes }) }),
      ),
  });
  const sheet = await generateRoutes(page);

  // 収める動きが終わって地図が止まってから読む。
  await expect
    .poll(() => page.evaluate(() => !window.__liveMap().isMoving() && window.__liveMap().loaded()), { timeout: 15_000 })
    .toBe(true);
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox).not.toBeNull();
  const onScreen = await page.evaluate((points) => {
    const map = window.__liveMap();
    const box = map.getCanvas().getBoundingClientRect();
    return points.map(([lng, lat]) => {
      const { x, y } = map.project([lng, lat]);
      return { x: Math.round(box.left + x), y: Math.round(box.top + y) };
    });
  }, NORTH_SOUTH_ROUTE);
  const sheetTop = sheetBox?.y ?? 0;
  expect(onScreen.filter(({ x, y }) => x < 0 || x > MOBILE_VIEWPORT.width || y < 0 || y > sheetTop)).toEqual([]);
});
