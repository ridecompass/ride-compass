import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { moved } from "@/testing/movedPoint";

import { INTRO_CLOSED, installApiMocks, installMapFinder, seedStoredState } from "./fixtures";

// 走行モードで、ブラウザが届ける位置の変化が実際の地図の動き（中心・向き）まで届くこと（パターン4 観点2）。単体テストの地図は
// 代役で、カメラを動かさない。走行モードの移り変わり（休む・戻す・止める）の判断は useRideMode.test.ts が持ち、ここでは
// それが地図に現れるかだけを見る。位置はブラウザの位置の差し替え（`setGeolocation`）で届け、向きを持たせない（動いた向きから出る）。

const START = { latitude: 35.7536, longitude: 139.7378 };

/** 地図が止まっていれば、その地点を地図が描く画面の位置。動いている間はnull。 */
async function screenPointOf(page: Page, at: { latitude: number; longitude: number }) {
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
async function settledScreenPoint(page: Page, at: { latitude: number; longitude: number }) {
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

/** 地図が止まっていて、その地点が画面の`expected`に描かれるまで待つ（地図がその地点を追ったか）。 */
async function expectDrawnAt(
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
async function deliverPosition(page: Page, context: BrowserContext, at: { latitude: number; longitude: number }) {
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
async function dotOffsetFrom(page: Page, at: { latitude: number; longitude: number }) {
  const box = await page.getByRole("img", { name: "現在地" }).boundingBox();
  const point = await screenPointOf(page, at);
  if (box === null || point === null) return Infinity;
  return Math.hypot(box.x + box.width / 2 - point.x, box.y + box.height / 2 - point.y);
}

/** ボタンの計算後の面の色と縁の影。 */
const buttonLook = (button: Locator) =>
  button.evaluate((el) => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, ring: style.boxShadow };
  });

/** 現在地の印の扇形の中心が、点の中心からどちらにあるか（画面の上が0・時計回りの度）。扇形が出ていなければnull。 */
const coneDirection = (page: Page) =>
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

const mapBearing = (page: Page) =>
  page.evaluate(() => {
    const map = window.__liveMap();
    return map.isMoving() ? NaN : (map.getBearing() + 360) % 360;
  });

test("走行モードの間、地図は届いた位置を同じ所に描き続け、進む向きを上にでき、指で動かすと休み、止めると追わない", async ({
  page,
  context,
  browserName,
}) => {
  // 共通の段取りが位置を許して初期の地点に置くので、そのあとに走り出す位置へ置き直す。
  await installApiMocks(page);
  await context.setGeolocation(START);
  await seedStoredState(page, INTRO_CLOSED);
  await page.addInitScript(installMapFinder);
  await page.goto("/");
  await expect(page.getByText("地図を読み込み中…")).toBeHidden({ timeout: 15_000 });

  // 走行モードの入切と休んでいる間は、ボタンの面の色と縁で見分けられる（パターン4 観点3: 地図の操作のボタンの既定の面に負けない）。
  const rideButton = page.getByRole("button", { name: "走行モード" });
  const offLook = await buttonLook(rideButton);
  await rideButton.click();
  await expect(rideButton).toHaveAttribute("aria-pressed", "true");
  const dot = page.getByRole("img", { name: "現在地" });
  await expect(dot).toBeVisible();
  await expect.poll(async () => (await buttonLook(rideButton)).background).not.toBe(offLook.background);

  // 走り出す位置は出発地と同じ（共通の段取りの位置を置き直してから開いた）。現在地の印は、出発地の印がいつ作り直されても上に
  // 描かれるよう、ほかの印より大きい重なり順を持つ（パターン4 観点3: 計算後の値）。
  const zOrder = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".maplibregl-marker")].map((marker) => ({
      ride: marker.querySelector("[data-facing-cone]") !== null,
      z: Number(getComputedStyle(marker).zIndex) || 0,
    })),
  );
  const rideZ = zOrder.filter(({ ride }) => ride).map(({ z }) => z);
  expect(rideZ).toHaveLength(1);
  expect(zOrder.filter(({ ride }) => !ride).length).toBeGreaterThan(0);
  expect(zOrder.filter(({ ride, z }) => !ride && z >= rideZ[0])).toEqual([]);

  // スマホが東を向くと、現在地の印の扇形が東を指す（地図が北を上にしている間）。出来事はブラウザの違いによらず読める形で届ける。
  expect(await coneDirection(page)).toBeNull();
  await page.evaluate(() => {
    const event = new Event("deviceorientation");
    Object.assign(event, { alpha: 0, webkitCompassHeading: 90 });
    window.dispatchEvent(event);
  });
  await expect.poll(() => coneDirection(page)).toBeCloseTo(90, -1);

  // 最初の位置へ寄せ終わったら、そこに描かれた所を基準にし、東へ動いても同じ所に描かれる（地図が追った）。
  const anchor = await settledScreenPoint(page, START);
  const east = moved(START, 0, 200);
  await context.setGeolocation(east);
  await expectDrawnAt(page, east, anchor);
  // 200m を数秒で動いた（とても速い）ので、追い始めの倍率（15）からいちばん引いた所（2段）まで引く。WebKit では見ない:
  // Playwright が差し替えの位置の時刻をミリ秒で渡し、WebKit がそれを秒として受けて1000倍にする（WebCore の
  // `Geolocation.cpp` の `convertSecondsToEpochTimeStamp`）ため、2つの位置の間が1000倍長く見え、速さがほぼ0になる。
  if (browserName !== "webkit") {
    await expect.poll(() => page.evaluate(() => window.__liveMap().getZoom()), { timeout: 10_000 }).toBeCloseTo(13, 1);
  }

  // 進む向きを上にすると、地図は動いた向き（東）を上に回す。北を上に戻すと向きも戻る。
  await page.getByRole("button", { name: /^進む向きを上にする/ }).click();
  await expect.poll(() => mapBearing(page), { timeout: 10_000 }).toBeCloseTo(90, 0);
  await page.getByRole("button", { name: /^北を上にする/ }).click();
  await expect.poll(() => mapBearing(page), { timeout: 10_000 }).toBeCloseTo(0, 0);

  // 指で地図を動かすと追うのを休み、次の位置が届いても地図は動かない（点だけが動く）。
  const canvas = (await page.locator(".maplibregl-canvas").boundingBox())!;
  const from = { x: canvas.x + canvas.width / 3, y: canvas.y + canvas.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 120, from.y + 60, { steps: 10 });
  await page.mouse.up();
  await expect(rideButton).toHaveAttribute("title", "地図を現在地へ戻す");
  // 面の色は移り変わり（transition）を持つので、落ち着くまで待って比べる。
  await expect.poll(async () => (await buttonLook(rideButton)).background).toBe(offLook.background);
  expect((await buttonLook(rideButton)).ring).not.toBe(offLook.ring);
  // 引いた倍率でも画面の上で見分けられるだけ動かす。
  const pausedAt = moved(east, 1500, 0);
  await deliverPosition(page, context, pausedAt);
  await expect.poll(() => dotOffsetFrom(page, pausedAt), { timeout: 10_000 }).toBeLessThan(2);
  const whilePaused = (await screenPointOf(page, pausedAt))!;
  expect(Math.hypot(whilePaused.x - anchor.x, whilePaused.y - anchor.y)).toBeGreaterThan(50);

  // 押すと現在地へ戻って追い直す。
  await rideButton.click();
  await expectDrawnAt(page, pausedAt, anchor);

  // 止めると点が消え、次の位置が届いても地図は動かない。
  await rideButton.click();
  await expect(rideButton).toHaveAttribute("aria-pressed", "false");
  await expect(dot).toBeHidden();
  const afterStop = moved(pausedAt, 0, 200);
  // 止めると左のパネルが戻って地図の幅が変わるので、落ち着いた位置を基準にする。
  const before = await settledScreenPoint(page, pausedAt);
  await deliverPosition(page, context, afterStop);
  const after = await screenPointOf(page, pausedAt);
  expect(after).not.toBeNull();
  expect(Math.hypot(after!.x - before.x, after!.y - before.y)).toBeLessThan(1);
});
