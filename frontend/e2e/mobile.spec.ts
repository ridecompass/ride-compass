import { expect, test } from "@playwright/test";
import { MATERIAL_VALUE_FORMULA, catalogEntry } from "@/testing/catalogAxes";
import {
  MOBILE_VIEWPORT,
  axisCatalogFixture,
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
              // 凡例は周りの道を塗れる軸（式の木を持つ軸）にだけ出る。
              way_value_formula: MATERIAL_VALUE_FORMULA,
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

// 観点1（収まる）: 「保存済み」タブの「プリセット」の一覧は、何も知らせていない間、上に空白を作らず「地点」の一覧と同じ高さから
// 始まる。知らせの行は読み上げのために置いたままなので、場所を取るかは実寸でしか見えない。
test("モバイル: 「保存済み」の「プリセット」の一覧は、「地点」の一覧と同じ高さから始まる", async ({ page }) => {
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
          routePreference: null,
          roadAvoidance: {},
        },
      ]),
    },
  });
  const sheet = await openMobileSheet(page, "ルート設定");
  await sheet.getByRole("tab", { name: "保存済み" }).click();

  const firstRowTop = async (tab: string) => {
    await sheet.getByRole("tab", { name: tab }).click();
    const row = sheet.getByRole("tabpanel", { name: tab }).getByRole("listitem").first();
    await expect(row).toBeVisible();
    return (await row.boundingBox())!.y;
  };
  expect(await firstRowTop("プリセット")).toBe(await firstRowTop("地点"));
});
