import { expect, test, type Page } from "@playwright/test";
import { MAIN_MAP_CANVAS, MOBILE_VIEWPORT, openMobileApp } from "./fixtures";
import { pinchOpen } from "./componentScans";

// 地図の上で始めたピンチは、ページではなく地図を拡大する（パターン4 観点2）。地図のcanvas以外の部品から
// 始めたピンチがページを拡大しないことは、全状態の走査（all-states.spec.ts）がモバイル幅の全部品で見る。
// touch-actionはタッチの始点の要素と祖先で決まり、計算後のCSSの値を読むだけでは効いているかが分からないので、
// 実際に2本指のタッチを送って見る。
test.describe("タッチ端末", () => {
  test.use({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });

  test("地図の上で始めたピンチは、ページではなく地図を拡大する", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "2本指のタッチはCDP（Chromiumだけの口）でしか送れない");
    await openMobileApp(page);
    const zoom = () => page.evaluate(() => window.__liveMap().getZoom());
    const zoomBefore = await zoom();

    // 指を左右に開くので、その幅がcanvasの上に収まる点で始める。
    const point = await freeCanvasPoint(page, [
      [-80, 0],
      [0, 0],
      [80, 0],
    ]);
    const client = await page.context().newCDPSession(page);
    await pinchOpen(client, point.x, point.y);
    await expect.poll(zoom, { timeout: 5000 }).toBeGreaterThan(zoomBefore);
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
  });
});

/** 地図のcanvasの上で、指を置く位置（点からのずれ`reach`の全部）がほかの部品に覆われない点を、中央から縦に探す。 */
async function freeCanvasPoint(
  page: Page,
  reach: readonly (readonly [number, number])[],
): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(
    ({ reach, selector }) => {
      const canvas = document.querySelector(selector);
      const box = canvas?.getBoundingClientRect();
      if (!canvas || !box) return null;
      for (let dy = 0; dy < box.height / 2; dy += 8) {
        for (const y of [box.top + box.height / 2 + dy, box.top + box.height / 2 - dy]) {
          const x = box.left + box.width / 2;
          if (reach.every(([rx, ry]) => document.elementFromPoint(x + rx, y + ry) === canvas)) return { x, y };
        }
      }
      return null;
    },
    { reach, selector: MAIN_MAP_CANVAS },
  );
  expect(point, "指を置ける地図の点が無い").not.toBeNull();
  return point!;
}
