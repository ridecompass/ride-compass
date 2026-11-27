import { expect, test } from "@playwright/test";
import { clickFeature, doneJobFixture, generateRoutes, openMobileApp, routeGenerateResponseFixture } from "./fixtures";

// 地図で押した区間の小窓の、×の大きさと置き方（パターン4 観点1・3）。

// 観点3（カスケードの勝ち負け）: 地図で押した区間の小窓の×は、MapLibreの既定の大きさに負けず、指で押せる幅32px・高さ44pxを持つ。
// ×の寸法はMapLibreのCSSとアプリのCSSの勝ち負けで決まり、実ブラウザでしか決まらない。
test("モバイル: 地図で押した区間の小窓の×は、幅32px・高さ44pxの押す所を持つ", async ({ page }) => {
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
  expect([close.width, close.height]).toEqual([32, 44]);
});

// 観点1（収まる）: 地図で押した区間の小窓は、押した区間の線に重ならない。区間の下か上に入れば地図を動かさず、どちらにも入らなければ
// 地図を動かして入る所を作る。小窓の高さと、区間が画面のどこに映るかは、実寸と地図の投影でしか決まらない。
// 区間は南北に走らせ、押す点は区間の真ん中にする。押した所を指して上か下へ出すと、小窓は区間の線に掛かる。
const NORTH_SOUTH_SEGMENT: [number, number][] = [
  [139.7387, 35.74],
  [139.7387, 35.76],
  [139.7387, 35.78],
];

test("モバイル: 地図で押した区間の小窓は、押した区間の線に重ならず、上にも下にも入らないときだけ地図を動かす", async ({
  page,
}) => {
  const generated = routeGenerateResponseFixture();
  const routes = generated.routes.map((route) => {
    const [first] = route.segments;
    const [[startLng, startLat], , [endLng, endLat]] = NORTH_SOUTH_SEGMENT;
    return {
      ...route,
      geometry: { type: "LineString" as const, coordinates: NORTH_SOUTH_SEGMENT },
      segments: [
        {
          ...first,
          geometry: { type: "LineString" as const, coordinates: NORTH_SOUTH_SEGMENT },
          point_distances_m: [0, 2_200, 4_400],
          start_latitude: startLat,
          start_longitude: startLng,
          end_latitude: endLat,
          end_longitude: endLng,
          distance_km: 4.4,
        },
      ],
    };
  });
  await openMobileApp(page, {
    routes: (page) =>
      page.route("**/api/routes/generate/*", (route) =>
        route.fulfill({ json: doneJobFixture({ ...generated, routes }) }),
      ),
  });
  await generateRoutes(page);
  await page.getByRole("button", { name: "ルート結果", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "ルート結果" })).toBeHidden();
  const settled = () => page.evaluate(() => !window.__liveMap().isMoving() && window.__liveMap().loaded());
  const camera = () =>
    page.evaluate(() => {
      const map = window.__liveMap();
      return { center: map.getCenter().toArray(), zoom: map.getZoom() };
    });
  const popup = page.locator(".maplibregl-popup", { has: page.getByRole("group", { name: "区間の小窓の上の帯" }) });
  /** 区間の線を細かく刻んだ点のうち、小窓の箱の中に映るもの。 */
  const covered = () =>
    page.evaluate((line) => {
      const map = window.__liveMap();
      const canvas = map.getCanvas().getBoundingClientRect();
      const box = document
        .querySelector(".maplibregl-popup:has([aria-label='区間の小窓の上の帯'])")!
        .getBoundingClientRect();
      const steps = 100;
      const inside: { x: number; y: number }[] = [];
      for (let i = 0; i < line.length - 1; i += 1) {
        for (let step = 0; step <= steps; step += 1) {
          const t = step / steps;
          const { x, y } = map.project([
            line[i][0] + (line[i + 1][0] - line[i][0]) * t,
            line[i][1] + (line[i + 1][1] - line[i][1]) * t,
          ]);
          const at = { x: canvas.left + x, y: canvas.top + y };
          if (at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom) inside.push(at);
        }
      }
      return inside;
    }, NORTH_SOUTH_SEGMENT);

  // 生成で収めた区間は、下か上に小窓が入るので、地図は動かない。
  await expect.poll(settled, { timeout: 15_000 }).toBe(true);
  const fitted = await camera();
  await clickFeature(page, "routeSegment");
  await expect(popup).toBeVisible();
  await expect.poll(settled, { timeout: 15_000 }).toBe(true);
  expect(await covered()).toEqual([]);
  expect(await camera()).toEqual(fitted);

  // 寄せて区間が画面を縦に貫くと、上にも下にも入らないので、地図を動かして入る所を作る。
  await popup.locator(".maplibregl-popup-close-button").click();
  await expect(popup).toBeHidden();
  await page.evaluate(
    (at) => window.__liveMap().jumpTo({ center: at, zoom: window.__liveMap().getZoom() + 3 }),
    NORTH_SOUTH_SEGMENT[1],
  );
  await expect.poll(settled, { timeout: 15_000 }).toBe(true);
  const zoomedIn = await camera();
  await clickFeature(page, "routeSegment");
  await expect(popup).toBeVisible();
  await expect.poll(async () => (await settled()) && (await covered()).length === 0, { timeout: 15_000 }).toBe(true);
  expect(await camera()).not.toEqual(zoomedIn);
});
