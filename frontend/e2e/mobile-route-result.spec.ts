import { expect, test } from "@playwright/test";
import {
  MOBILE_VIEWPORT,
  clickFeature,
  doneJobFixture,
  generateRoutes,
  installMapFinder,
  openMobileApp,
  routeGenerateResponseFixture,
} from "./fixtures";

// 生成した「ルート結果」の、地図とグラフの置き方と、地図で押した区間の小窓（パターン4 観点1〜3）。

// 観点1（収まる）: 生成したルートを地図へ収めると、開いた「ルート結果」のシートに隠れず、その上の見えている所に描かれる。
// 地図がどこまで覆われているかは実寸でしか決まらない（シートの高さは中身に合わせて決まる）。
// ルートは南北に長くする。東西に長いと幅で倍率が決まり、覆う物を避けなくても地図の中ほどの細い帯に収まってしまう。
const NORTH_SOUTH_ROUTE: [number, number][] = [
  [139.7387, 35.74],
  [139.74, 35.78],
  [139.7387, 35.74],
];

test("モバイル: 生成したルートを地図へ収めると、開いた「ルート結果」のシートの上の空きを埋めて描かれる", async ({
  page,
}) => {
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
  // 空き（上の部品の下端からシートの上端まで）を埋めていること。中身へ合わせる前のシートの高さで収めると、空きの上の方に小さく残る。
  const freeTop = await page.evaluate(() =>
    Math.max(
      0,
      ...[...document.querySelectorAll('[data-map-overlay-edge="top"]')].map((el) => el.getBoundingClientRect().bottom),
    ),
  );
  const ys = onScreen.map(({ y }) => y);
  expect((Math.max(...ys) - Math.min(...ys)) / (sheetTop - freeTop)).toBeGreaterThan(0.7);
});

// 観点1（収まる）: 道のりのグラフの切り替えは、結果のシートの図も走行中の地図の下の図も、図の上に段を取らずに図の右上に
// 重ねる。走行中の図は結果のシートの図より高く描いて画面に収める。重なりと高さは実寸でしか決まらない。
test("モバイル: 道のりのグラフの切り替えは、結果も走行中も図の右上に重ね、走行中の図は結果の図より高く画面に収まる", async ({
  page,
}) => {
  // 切り替えが図の右半分の中に収まる（図の上に段を取らず、左上の値の目盛りに掛からない）。
  const expectOnTopRight = (
    tabs: { x: number; y: number; width: number; height: number },
    graph: { x: number; y: number; width: number; height: number },
  ) => {
    expect(tabs.y).toBeGreaterThanOrEqual(graph.y);
    expect(tabs.y + tabs.height).toBeLessThanOrEqual(graph.y + graph.height);
    expect(tabs.x).toBeGreaterThan(graph.x + graph.width / 2);
    expect(tabs.x + tabs.width).toBeLessThanOrEqual(graph.x + graph.width);
  };
  await openMobileApp(page);
  const sheet = await generateRoutes(page);
  const resultGraph = (await sheet.getByRole("slider", { name: /^道のりに沿った難易度/ }).boundingBox())!;
  const resultTabs = (await sheet.getByRole("tablist", { name: "道のりのグラフ" }).boundingBox())!;
  expectOnTopRight(resultTabs, resultGraph);

  await sheet.getByRole("button", { name: /このルートで走る/ }).click();
  const ride = page.getByRole("region", { name: "予定ルートのプロファイル" });
  const rideGraph = (await ride.getByRole("slider", { name: /^道のりに沿った難易度/ }).boundingBox())!;
  const rideTabs = (await ride.getByRole("tablist", { name: "道のりのグラフ" }).boundingBox())!;
  expectOnTopRight(rideTabs, rideGraph);
  expect(rideGraph.height).toBeGreaterThan(resultGraph.height);
  expect(rideGraph.y + rideGraph.height).toBeLessThanOrEqual(MOBILE_VIEWPORT.height);
});

// 「ルート結果」のシート。高さを決めていなければ、開いたときに候補と道のりのグラフの下端までが入る高さに合わせ、グラフは
// シートの幅いっぱいに描く（パターン4 観点1）。グラフの上から縦になぞるとシートの本文が動き、横になぞると地点を選ぶ（観点2）。
// touch-actionはタッチの始点の要素と祖先で決まり、計算後のCSSの値を読むだけでは効いているかが分からないので、
// 実際に1本指のタッチを送って見る。
test.describe("タッチ端末", () => {
  test.use({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });

  test("モバイル: 「ルート結果」のシートは開くとグラフの下端までが入り、グラフの上の縦のなぞりで本文が動き、横のなぞりで地点を選ぶ", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "1本指のタッチの列はCDP（Chromiumだけの口）でしか送れない");
    await openMobileApp(page);
    const sheet = await generateRoutes(page);
    const graph = sheet.getByRole("slider", { name: /^道のりに沿った難易度/ });
    const sheetBox = (await sheet.boundingBox())!;
    const graphBox = (await graph.boundingBox())!;
    const sheetBottom = sheetBox.y + sheetBox.height;
    const graphBottom = graphBox.y + graphBox.height;
    // グラフの下には距離の目盛りの1行と本文の下の余白だけが残る。
    expect(graphBottom).toBeLessThanOrEqual(sheetBottom);
    expect(sheetBottom - graphBottom).toBeLessThan(48);
    // 本文の左右の余白を除いた幅いっぱい。
    expect(graphBox.width).toBeGreaterThan(sheetBox.width - 48);

    const scrollTopOfBody = () =>
      sheet.evaluate((root) => {
        const body = Array.from(root.querySelectorAll<HTMLElement>("*")).find(
          (el) => getComputedStyle(el).overflowY === "auto",
        );
        return body?.scrollTop ?? -1;
      });
    expect(await scrollTopOfBody()).toBe(0);

    const client = await page.context().newCDPSession(page);
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...from, id: 1 }] });
      for (let step = 1; step <= 10; step += 1) {
        const point = { x: from.x + ((to.x - from.x) * step) / 10, y: from.y + ((to.y - from.y) * step) / 10 };
        await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, id: 1 }] });
      }
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    const center = { x: graphBox.x + graphBox.width / 2, y: graphBox.y + graphBox.height / 2 };

    await drag(center, { x: center.x, y: center.y - 120 });
    await expect.poll(scrollTopOfBody).toBeGreaterThan(0);
    await expect(sheet.getByRole("button", { name: "区間を地図で見る" })).toHaveCount(0);

    const moved = (await graph.boundingBox())!;
    const row = moved.y + moved.height / 2;
    await drag({ x: moved.x + moved.width * 0.2, y: row }, { x: moved.x + moved.width * 0.6, y: row });
    await expect(sheet.getByRole("button", { name: "区間を地図で見る" })).toBeVisible();
  });
});

// 観点3（カスケードの勝ち負け）: 地図で押した区間の小窓の×は、MapLibreの既定の大きさに負けず、指で押せる44px四方を持つ。
// ×の寸法はMapLibreのCSSとアプリのCSSの勝ち負けで決まり、実ブラウザでしか決まらない。
test("モバイル: 地図で押した区間の小窓の×は、44px四方の押す所を持つ", async ({ page }) => {
  await page.addInitScript(installMapFinder);
  await openMobileApp(page);
  await generateRoutes(page);
  // 「ルート結果」を閉じて見るだけの間にすると、押した区間の中身を小窓に出す。
  await page.getByRole("button", { name: "ルート結果", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "ルート結果" })).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => !window.__liveMap().isMoving() && window.__liveMap().loaded()), { timeout: 15_000 })
    .toBe(true);

  await clickFeature(page, "routeSegment");

  const popup = page.locator(".maplibregl-popup", { has: page.getByRole("group", { name: "区間の小窓の上の帯" }) });
  const close = (await popup.locator(".maplibregl-popup-close-button").boundingBox())!;
  expect([close.width, close.height]).toEqual([44, 44]);
});
