import { expect, test } from "@playwright/test";
import {
  MOBILE_VIEWPORT,
  doneJobFixture,
  generateRoutes,
  openMobileApp,
  routeGenerateResponseFixture,
} from "./fixtures";

// 生成した「ルート結果」の、地図とグラフの置き方（パターン4 観点1〜3）。地図で押した区間の小窓は`e2e/segment-popup.spec.ts`が見る。

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

// 観点1（収まる）: 道のりのグラフの切り替えは、結果のシートの図では図の枠の上の端の名前の帯に図の名前と並んで載り、中身（棒）は
// 帯の下から描く。帯の無い走行中の地図の下の図では、図の右上に重ねる。走行中の図は結果のシートの図より高く描いて画面に収める。
// 重なりと高さは実寸でしか決まらない。
test("モバイル: 道のりのグラフの切り替えは、結果では図の上の帯に名前と並んで載って中身に掛からず、走行中は図の右上に重ね、走行中の図は結果の図より高く画面に収まる", async ({
  page,
}) => {
  type Box = { x: number; y: number; width: number; height: number };
  // 切り替えが図の右半分の幅に収まる（左の図の名前・値の目盛りに掛からない）。
  const expectOnRightHalf = (tabs: Box, graph: Box) => {
    expect(tabs.x).toBeGreaterThan(graph.x + graph.width / 2);
    expect(tabs.x + tabs.width).toBeLessThanOrEqual(graph.x + graph.width);
  };
  await openMobileApp(page);
  const sheet = await generateRoutes(page);
  const resultGraph = (await sheet.getByRole("slider", { name: /^道のりに沿った負担/ }).boundingBox())!;
  const resultTabs = (await sheet.getByRole("tablist", { name: "道のりのグラフ" }).boundingBox())!;
  const band = sheet.getByText("道のりに沿った負担", { exact: true });
  const bandBox = (await band.boundingBox())!;
  // 帯は図の枠（中身と同じ地の色の面）の上の端で、名前は帯の左に、切り替えは同じ帯の右に載る。
  const frame = (await band.locator("..").boundingBox())!;
  expect(bandBox.y).toBe(frame.y);
  expect(resultGraph.y + resultGraph.height).toBe(frame.y + frame.height);
  const name = (await band.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const { x, width } = range.getBoundingClientRect();
    return { x, width };
  }))!;
  expect(name.x + name.width).toBeLessThan(resultTabs.x);
  expect(resultTabs.y).toBeGreaterThanOrEqual(frame.y);
  expectOnRightHalf(resultTabs, resultGraph);
  // 中身（棒）は帯の下から描き、名前にも切り替えにも隠れない。
  expect(resultGraph.y).toBeGreaterThanOrEqual(bandBox.y + bandBox.height);
  expect(resultGraph.y).toBeGreaterThanOrEqual(resultTabs.y + resultTabs.height);

  await sheet.getByRole("button", { name: /このルートで走る/ }).click();
  const ride = page.getByRole("region", { name: "予定ルートのプロファイル" });
  const rideGraph = (await ride.getByRole("slider", { name: /^道のりに沿った負担/ }).boundingBox())!;
  const rideTabs = (await ride.getByRole("tablist", { name: "道のりのグラフ" }).boundingBox())!;
  expectOnRightHalf(rideTabs, rideGraph);
  expect(rideTabs.y).toBeGreaterThanOrEqual(rideGraph.y);
  expect(rideTabs.y + rideTabs.height).toBeLessThanOrEqual(rideGraph.y + rideGraph.height);
  expect(rideGraph.height).toBeGreaterThan(resultGraph.height);
  expect(rideGraph.y + rideGraph.height).toBeLessThanOrEqual(MOBILE_VIEWPORT.height);
});

// 「ルート結果」のシート。高さを決めていなければ、開いたときに見出し・候補・道のりのグラフの下端までが入る高さに合わせ、グラフは
// シートの幅いっぱいに描く（パターン4 観点1）。カードの数字の見方は、並びの上に行を取らず、並びの先頭にカードと同じ高さの見本で示す。
test("モバイル: 「ルート結果」のシートは開くと、カードの並びとグラフの下端までがスクロールせずに入り、数字の見方の見本はカードと同じ段に並ぶ", async ({
  page,
}) => {
  await openMobileApp(page);
  const sheet = await generateRoutes(page);
  const sheetBox = (await sheet.boundingBox())!;
  const graphBox = (await sheet.getByRole("slider", { name: /^道のりに沿った負担/ }).boundingBox())!;
  const sheetBottom = sheetBox.y + sheetBox.height;
  const graphBottom = graphBox.y + graphBox.height;
  // グラフの下には距離の目盛りの1行と本文の下の余白だけが残る。
  expect(graphBottom).toBeLessThanOrEqual(sheetBottom);
  expect(sheetBottom - graphBottom).toBeLessThan(48);
  // 本文の左右の余白を除いた幅いっぱい。
  expect(graphBox.width).toBeGreaterThan(sheetBox.width - 48);
  // 見本は並びの先頭で、候補のカードと同じ段・同じ高さに並ぶ。その(i)は見本の中にある。
  const sampleBox = (await sheet.getByRole("group", { name: "カードの数字の見方" }).boundingBox())!;
  const firstCard = (await sheet.getByRole("tablist", { name: "ルート結果" }).getByRole("tab").first().boundingBox())!;
  expect(sampleBox.x + sampleBox.width).toBeLessThanOrEqual(firstCard.x);
  expect(sampleBox.y).toBe(firstCard.y);
  expect(sampleBox.height).toBe(firstCard.height);
  const infoBox = (await sheet.getByRole("button", { name: "所要時間と負担の説明を表示" }).boundingBox())!;
  expect(infoBox.y).toBeGreaterThanOrEqual(sampleBox.y);
  expect(infoBox.y + infoBox.height).toBeLessThanOrEqual(sampleBox.y + sampleBox.height);
});

// グラフの上から縦になぞるとシートの本文が動き、横になぞると地点を選ぶ（観点2）。本文に送る分があるのは、利用者が
// シートを中身より低く決めたときなので、決めた高さを最も低くして開く。
// touch-actionはタッチの始点の要素と祖先で決まり、計算後のCSSの値を読むだけでは効いているかが分からないので、
// 実際に1本指のタッチを送って見る。
test.describe("タッチ端末", () => {
  test.use({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });

  test("モバイル: 「ルート結果」のグラフの上の縦のなぞりで本文が動き、横のなぞりで地点を選ぶ", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "1本指のタッチの列はCDP（Chromiumだけの口）でしか送れない");
    await openMobileApp(page, { storedState: { "ridecompass:mobile-sheet-height-vh": "20" } });
    const sheet = await generateRoutes(page);
    const graph = sheet.getByRole("slider", { name: /^道のりに沿った負担/ });

    const scrollTopOfBody = () =>
      sheet.evaluate((root) => {
        const body = Array.from(root.querySelectorAll<HTMLElement>("*")).find(
          (el) => getComputedStyle(el).overflowY === "auto",
        );
        return body?.scrollTop ?? -1;
      });
    // グラフを本文の見える所まで送る（本文は下端まで送られる）。
    await graph.scrollIntoViewIfNeeded();
    const scrolled = await scrollTopOfBody();
    expect(scrolled).toBeGreaterThan(0);

    const client = await page.context().newCDPSession(page);
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...from, id: 1 }] });
      for (let step = 1; step <= 10; step += 1) {
        const point = { x: from.x + ((to.x - from.x) * step) / 10, y: from.y + ((to.y - from.y) * step) / 10 };
        await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, id: 1 }] });
      }
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    const graphBox = (await graph.boundingBox())!;
    const center = { x: graphBox.x + graphBox.width / 2, y: graphBox.y + graphBox.height / 2 };

    await drag(center, { x: center.x, y: center.y + 120 });
    await expect.poll(scrollTopOfBody).toBeLessThan(scrolled);
    await expect(sheet.getByRole("button", { name: "区間を地図で見る" })).toHaveCount(0);

    await graph.scrollIntoViewIfNeeded();
    const moved = (await graph.boundingBox())!;
    const row = moved.y + moved.height / 2;
    await drag({ x: moved.x + moved.width * 0.2, y: row }, { x: moved.x + moved.width * 0.6, y: row });
    await expect(sheet.getByRole("button", { name: "区間を地図で見る" })).toBeVisible();
  });
});
