import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";

// 走行モードの e2e が地図を読む段取り（画面の位置・倍率・現在地の印）と、ブラウザへ位置を届ける段取り。

export const START = { latitude: 35.7536, longitude: 139.7378 };

/** 地図が止まっていれば、その地点を地図が描く画面の位置。動いている間はnull。 */
export async function screenPointOf(page: Page, at: { latitude: number; longitude: number }) {
  return page.evaluate(
    ([lng, lat]) => {
      const map = window.__liveMap();
      if (map.isMoving()) return null;
      const projected = map.project([lng, lat]);
      const canvas = map.getCanvas().getBoundingClientRect();
      return { x: canvas.left + projected.x, y: canvas.top + projected.y };
    },
    [at.longitude, at.latitude] as const,
  );
}

/** 地図が寄せ終わって落ち着いたときに、その地点が描かれる画面の位置。寄せる動きは位置が届くたびに続けて起きうるので、
 * 止まっていることに加えて、少し置いても同じ所にあることを見る。 */
export async function settledScreenPoint(page: Page, at: { latitude: number; longitude: number }) {
  let settled: { x: number; y: number } | null = null;
  await expect
    .poll(
      async () => {
        const first = await screenPointOf(page, at);
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
        const second = await screenPointOf(page, at);
        settled =
          first !== null && second !== null && Math.hypot(first.x - second.x, first.y - second.y) < 0.5 ? second : null;
        return settled !== null;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return settled!;
}

/** 地図が動き終わって落ち着いたときの倍率。指を離したあとの慣性と、続けて寄せる動きが終わるまで待つ。 */
export async function settledZoom(page: Page) {
  let settled: number | null = null;
  await expect
    .poll(
      async () => {
        const read = () => page.evaluate(() => (window.__liveMap().isMoving() ? null : window.__liveMap().getZoom()));
        const first = await read();
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
        const second = await read();
        settled = first !== null && second !== null && Math.abs(first - second) < 1e-3 ? second : null;
        return settled !== null;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return settled!;
}

/** 地図が止まっていて、その地点が画面の`expected`に描かれるまで待つ（地図がその地点を追ったか）。 */
export async function expectDrawnAt(
  page: Page,
  at: { latitude: number; longitude: number },
  expected: { x: number; y: number },
) {
  await expect
    .poll(
      async () => {
        const point = await screenPointOf(page, at);
        return point === null ? Infinity : Math.hypot(point.x - expected.x, point.y - expected.y);
      },
      { timeout: 10_000 },
    )
    .toBeLessThan(2);
}

/** 位置を差し替え、それがページへ届いて、受けた描き直しまで済むのを待つ。テストの側でも位置を受け取り、その位置が届けば
 * アプリの受け取りへも届いている。 */
export async function deliverPosition(
  page: Page,
  context: BrowserContext,
  at: { latitude: number; longitude: number },
) {
  // 受け取りを張り終えてから差し替える（張る前に差し替えると、張った直後に届く位置を待ち損ねうる）。
  await page.evaluate(
    ([latitude, longitude]) => {
      const pending = window as unknown as { __delivered?: Promise<void> };
      pending.__delivered = new Promise<void>((resolve) => {
        const id = navigator.geolocation.watchPosition(
          (p) => {
            if (Math.abs(p.coords.latitude - latitude) > 1e-7 || Math.abs(p.coords.longitude - longitude) > 1e-7)
              return;
            navigator.geolocation.clearWatch(id);
            resolve();
          },
          // 張った直後は一時に取れない知らせが来ることがある。次の位置を待つ。
          () => {},
        );
      });
    },
    [at.latitude, at.longitude] as const,
  );
  await context.setGeolocation(at);
  await page.evaluate(() => (window as unknown as { __delivered: Promise<void> }).__delivered);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** 現在地の点の中心と、その地点が描かれる所との差。 */
export async function dotOffsetFrom(page: Page, at: { latitude: number; longitude: number }) {
  const box = await page.getByRole("img", { name: "現在地" }).boundingBox();
  const point = await screenPointOf(page, at);
  if (box === null || point === null) return Infinity;
  return Math.hypot(box.x + box.width / 2 - point.x, box.y + box.height / 2 - point.y);
}

/** ボタンの計算後の面の色と縁の影。 */
export const buttonLook = (button: Locator) =>
  button.evaluate((el) => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, ring: style.boxShadow };
  });

/** 現在地の印の扇形の中心が、点の中心からどちらにあるか（画面の上が0・時計回りの度）。扇形が出ていなければnull。 */
export const coneDirection = (page: Page) =>
  page.evaluate(() => {
    const cone = document.querySelector("[data-facing-cone]");
    const dot = cone?.parentElement?.querySelector("circle");
    if (!cone || !dot || cone.getAttribute("visibility") === "hidden") return null;
    const a = cone.getBoundingClientRect();
    const b = dot.getBoundingClientRect();
    const dx = a.x + a.width / 2 - (b.x + b.width / 2);
    const dy = a.y + a.height / 2 - (b.y + b.height / 2);
    return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  });

export const mapBearing = (page: Page) =>
  page.evaluate(() => {
    const map = window.__liveMap();
    return map.isMoving() ? NaN : (map.getBearing() + 360) % 360;
  });
