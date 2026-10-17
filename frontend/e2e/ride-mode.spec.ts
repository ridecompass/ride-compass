import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { trueHeadingDeg } from "@/lib/magneticDeclination";
import { moved } from "@/testing/movedPoint";
import { RIDE_MIN_ZOOM, RIDE_ZOOM_MAX_OUT } from "@/features/map/MapView/rideZoom";

import { INTRO_CLOSED, MOBILE_VIEWPORT, installApiMocks, installMapFinder, seedStoredState } from "./fixtures";

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

test("走行モードの間、地図は届いた位置を同じ所に描き続け、進む向きを上にでき、指で動かすと休み、止めると追わずに北を上へ戻す", async ({
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

  // スマホのコンパスが東（磁北から90度）を向くと、現在地の印の扇形は、その地点の偏角だけ戻した真北の基準の方角を指す（地図が北を上に
  // している間）。出来事はブラウザの違いによらず読める形で届ける。
  expect(await coneDirection(page)).toBeNull();
  await page.evaluate(() => {
    const event = new Event("deviceorientation");
    Object.assign(event, { alpha: 0, webkitCompassHeading: 90 });
    window.dispatchEvent(event);
  });
  await expect.poll(() => coneDirection(page)).toBeCloseTo(trueHeadingDeg(90, START), 0);

  // 最初の位置へ寄せ終わったら、そこに描かれた所を基準にし、東へ動いても同じ所に描かれる（地図が追った）。
  const anchor = await settledScreenPoint(page, START);
  const east = moved(START, 0, 200);
  await context.setGeolocation(east);
  await expectDrawnAt(page, east, anchor);
  // 200m を数秒で動いた（とても速い）ので、追い始めの倍率からいちばん引いた所まで引く。WebKit では見ない:
  // Playwright が差し替えの位置の時刻をミリ秒で渡し、WebKit がそれを秒として受けて1000倍にする（WebCore の
  // `Geolocation.cpp` の `convertSecondsToEpochTimeStamp`）ため、2つの位置の間が1000倍長く見え、速さがほぼ0になる。
  if (browserName !== "webkit") {
    await expect
      .poll(() => page.evaluate(() => window.__liveMap().getZoom()), { timeout: 10_000 })
      .toBeCloseTo(RIDE_MIN_ZOOM - RIDE_ZOOM_MAX_OUT, 1);
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
  const backToHere = page.getByRole("button", { name: "現在地へ戻る" });
  await expect(backToHere).toBeVisible();
  // 面の色は移り変わり（transition）を持つので、落ち着くまで待って比べる。
  await expect.poll(async () => (await buttonLook(rideButton)).background).toBe(offLook.background);
  expect((await buttonLook(rideButton)).ring).not.toBe(offLook.ring);
  // 引いた倍率でも画面の上で見分けられるだけ動かす。
  const pausedAt = moved(east, 1500, 0);
  await deliverPosition(page, context, pausedAt);
  await expect.poll(() => dotOffsetFrom(page, pausedAt), { timeout: 10_000 }).toBeLessThan(2);
  const whilePaused = (await screenPointOf(page, pausedAt))!;
  expect(Math.hypot(whilePaused.x - anchor.x, whilePaused.y - anchor.y)).toBeGreaterThan(50);

  // 地図の下の「現在地へ戻る」を押すと現在地へ戻って追い直す。
  await backToHere.click();
  await expectDrawnAt(page, pausedAt, anchor);
  await expect(backToHere).toBeHidden();

  // 東へ進んでから進む向きを上にしたまま止めると、地図を北が上へ戻し、点が消え、次の位置が届いても地図は動かない。
  const lastRidden = moved(pausedAt, 0, 200);
  await deliverPosition(page, context, lastRidden);
  await page.getByRole("button", { name: /^進む向きを上にする/ }).click();
  await expect.poll(() => mapBearing(page), { timeout: 10_000 }).toBeCloseTo(90, 0);
  await rideButton.click();
  await page.getByRole("button", { name: "案内を終える" }).click();
  await expect(rideButton).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => mapBearing(page), { timeout: 10_000 }).toBeCloseTo(0, 0);
  await expect(dot).toBeHidden();
  const afterStop = moved(lastRidden, 0, 200);
  // 止めると左のパネルが戻って地図の幅が変わるので、落ち着いた位置を基準にする。
  const before = await settledScreenPoint(page, lastRidden);
  await deliverPosition(page, context, afterStop);
  const after = await screenPointOf(page, lastRidden);
  expect(after).not.toBeNull();
  expect(Math.hypot(after!.x - before.x, after!.y - before.y)).toBeLessThan(1);
});

// 2本指でつまむ・広げる操作は、MapLibre が先に指の重心のずれを移動として受け、倍率が変わるのはそのあとになりうる。
// 出来事の並び（移動の始まり→拡大の始まり）は実ブラウザの MapLibre でしか出ないので、ここで指ごとのタッチを送って見る
// （パターン4 観点2）。
test.describe("タッチ端末", () => {
  test.use({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });

  test("走行モードで追っている間に2本指でつまむと、休まずにその倍率で追い続け、つまむ最中に位置が届いても倍率を戻さず、1本指で動かすと休む", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "指ごとのタッチの列はCDP（Chromiumだけの口）でしか送れない");
    // 位置の誤差を持たせ、その内の動きで届けて速さを0と読ませる（倍率に速さの引きを混ぜない）。
    const at = (point: { latitude: number; longitude: number }) => ({ ...point, accuracy: 50 });
    await installApiMocks(page);
    await context.setGeolocation(at(START));
    await seedStoredState(page, INTRO_CLOSED);
    await page.addInitScript(installMapFinder);
    await page.goto("/");
    await expect(page.getByText("地図を読み込み中…")).toBeHidden({ timeout: 15_000 });
    await page.getByRole("button", { name: "走行モード" }).click();
    const anchor = await settledScreenPoint(page, START);
    const zoom = () => page.evaluate(() => window.__liveMap().getZoom());
    const followedZoom = await zoom();
    const backToHere = page.getByRole("button", { name: "現在地へ戻る" });

    const client = await context.newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove", points: { x: number; y: number }[]) =>
      client.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, id) => ({ ...p, id })) });
    const canvas = (await page.locator(".maplibregl-canvas").boundingBox())!;
    const center = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
    const fingers = (gap: number, dx: number) => [
      { x: center.x + dx - gap / 2, y: center.y },
      { x: center.x + dx + gap / 2, y: center.y },
    ];

    // 指の間を240pxから80pxへ縮める（倍率は log2(3) 段だけ下がる）。先に重心だけを横へ動かし、移動として始まらせる
    // （2本の指を揃えて縦に動かすと、地図を傾ける操作になる）。
    const [fromGap, toGap, steps] = [240, 80, 10];
    const gapAt = (step: number) => fromGap + ((toGap - fromGap) * step) / steps;
    await touch("touchStart", fingers(fromGap, 0));
    await touch("touchMove", fingers(fromGap, 6));
    for (let step = 1; step <= steps / 2; step += 1) await touch("touchMove", fingers(gapAt(step), 6));
    // つまむ最中に届いた位置で、倍率を元へ戻さず、つまむ操作も止めない。
    const duringPinch = moved(START, 0, 10);
    await deliverPosition(page, context, at(duringPinch));
    for (let step = steps / 2 + 1; step <= steps; step += 1) await touch("touchMove", fingers(gapAt(step), 6));
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    const pinchedZoom = followedZoom - Math.log2(fromGap / toGap);
    await expect.poll(zoom, { timeout: 10_000 }).toBeCloseTo(pinchedZoom, 1);
    // 休まず、つまむ最中に届いた位置へ寄せ直し、次の位置もつまんだ倍率のまま追う。
    await expectDrawnAt(page, duringPinch, anchor);
    await expect(backToHere).toBeHidden();
    const next = moved(START, 0, 20);
    await deliverPosition(page, context, at(next));
    await expectDrawnAt(page, next, anchor);
    expect(await zoom()).toBeCloseTo(pinchedZoom, 1);
    await expect(backToHere).toBeHidden();

    // 1本指で動かすと休む。
    await touch("touchStart", [center]);
    for (let step = 1; step <= 10; step += 1) await touch("touchMove", [{ x: center.x - step * 10, y: center.y }]);
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(backToHere).toBeVisible();
  });
});
