import { expect, test } from "@playwright/test";
import { MATERIAL_VALUE_FORMULA, catalogEntry } from "@/testing/catalogAxes";
import {
  MOBILE_VIEWPORT,
  axisCatalogFixture,
  doneJobFixture,
  generateRoutes,
  installMapFinder,
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

  // 一般画面にはリクエストIDを含む長い文言を出さない。
  await expect(page.getByRole("img", { name: "観測値を取得できません" })).toBeVisible();
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
          routeMode: "loop",
          distance: "40",
          maxRoutes: "3",
          origin: null,
          waypoints: [],
          destination: null,
          routePreference: null,
          hardFilters: {},
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
    await expect(sheet.getByRole("button", { name: "区間の選択を解除" })).toHaveCount(0);

    const moved = (await graph.boundingBox())!;
    const row = moved.y + moved.height / 2;
    await drag({ x: moved.x + moved.width * 0.2, y: row }, { x: moved.x + moved.width * 0.6, y: row });
    await expect(sheet.getByRole("button", { name: "区間の選択を解除" })).toBeVisible();
  });
});
