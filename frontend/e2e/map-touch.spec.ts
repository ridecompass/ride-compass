import { expect, test, type Page } from "@playwright/test";
import { MOBILE_VIEWPORT, installMapFinder, openMobileApp } from "./fixtures";
import { pinchOpen } from "./componentScans";

// 地図の上で始めたピンチは、ページではなく地図を拡大する（パターン4 観点2）。地図のcanvas以外の部品から
// 始めたピンチがページを拡大しないことは、全状態の走査（all-states.spec.ts）がモバイル幅の全部品で見る。
// touch-actionはタッチの始点の要素と祖先で決まり、計算後のCSSの値を読むだけでは効いているかが分からないので、
// 実際に2本指のタッチを送って見る。
test.describe("タッチ端末", () => {
  test.use({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });

  test("地図の上で始めたピンチは、ページではなく地図を拡大する", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "2本指のタッチはCDP（Chromiumだけの口）でしか送れない");
    await page.addInitScript(installMapFinder);
    await openMobileApp(page);
    await expect(page.getByText("地図を読み込み中…")).toBeHidden({ timeout: 15_000 });
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

  // 地図は傾けない（奥へ倒れると道とルートが読みにくい）が、回すのは使う（パターン4 観点2）。2本指を揃えて縦になぞる・右ドラッグで
  // 縦に動かすのは MapLibre の傾ける手ぶりで、実ブラウザでしか起きないので、指とマウスを実際に送って見る。
  test("地図は2本指で縦になぞっても、右ドラッグで縦に動かしても傾かず、2本指でひねると回る", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "2本指のタッチはCDP（Chromiumだけの口）でしか送れない");
    await page.addInitScript(installMapFinder);
    await openMobileApp(page);
    await expect(page.getByText("地図を読み込み中…")).toBeHidden({ timeout: 15_000 });
    const pitch = () => page.evaluate(() => window.__liveMap().getPitch());
    const bearing = () => page.evaluate(() => window.__liveMap().getBearing());

    // 指は中心から左右60pxに置き、上へ120pxなぞる（MapLibre は上へなぞると奥へ倒し、下へは0度より戻さない）か、
    // 半径60pxのまま45度ひねる。右ドラッグは中心の120px下から中心へ上げる。どの位置もcanvasの上に収める。
    const center = await freeCanvasPoint(page, [
      [-60, 0],
      [60, 0],
      [-60, -120],
      [60, -120],
      [0, 120],
      [-43, -43],
      [43, 43],
    ]);
    const client = await page.context().newCDPSession(page);
    const touch = async (type: "touchStart" | "touchMove", fingers: { x: number; y: number }[]) =>
      client.send("Input.dispatchTouchEvent", { type, touchPoints: fingers.map((p, id) => ({ ...p, id })) });
    const lift = () => client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const fingersAt = (dy: number, turnDeg: number) => {
      const [dx, dyTurn] = [60 * Math.cos((turnDeg * Math.PI) / 180), 60 * Math.sin((turnDeg * Math.PI) / 180)];
      return [
        { x: center.x - dx, y: center.y + dy - dyTurn },
        { x: center.x + dx, y: center.y + dy + dyTurn },
      ];
    };

    await touch("touchStart", fingersAt(0, 0));
    for (let step = 1; step <= 10; step += 1) await touch("touchMove", fingersAt(-step * 12, 0));
    await lift();
    expect(await pitch()).toBe(0);

    await page.mouse.move(center.x, center.y + 120);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(center.x, center.y, { steps: 10 });
    await page.mouse.up({ button: "right" });
    expect(await pitch()).toBe(0);

    const bearingBefore = await bearing();
    await touch("touchStart", fingersAt(0, 0));
    for (let step = 1; step <= 10; step += 1) await touch("touchMove", fingersAt(0, step * 4.5));
    await lift();
    await expect.poll(async () => Math.abs((await bearing()) - bearingBefore), { timeout: 5000 }).toBeGreaterThan(5);
    expect(await pitch()).toBe(0);
  });
});

/** 地図のcanvasの上で、指を置く位置（点からのずれ`reach`の全部）がほかの部品に覆われない点を、中央から縦に探す。 */
async function freeCanvasPoint(
  page: Page,
  reach: readonly (readonly [number, number])[],
): Promise<{ x: number; y: number }> {
  const point = await page.evaluate((reach) => {
    const canvas = document.querySelector("canvas.maplibregl-canvas");
    const box = canvas?.getBoundingClientRect();
    if (!canvas || !box) return null;
    for (let dy = 0; dy < box.height / 2; dy += 8) {
      for (const y of [box.top + box.height / 2 + dy, box.top + box.height / 2 - dy]) {
        const x = box.left + box.width / 2;
        if (reach.every(([rx, ry]) => document.elementFromPoint(x + rx, y + ry) === canvas)) return { x, y };
      }
    }
    return null;
  }, reach);
  expect(point, "指を置ける地図の点が無い").not.toBeNull();
  return point!;
}
