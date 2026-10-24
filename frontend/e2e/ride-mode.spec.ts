import { expect, test } from "@playwright/test";
import { trueHeadingDeg } from "@/lib/magneticDeclination";
import { moved } from "@/testing/movedPoint";
import { RIDE_ZOOM_MAX_OUT, RIDE_ZOOM_STEPS } from "@/features/map/MapView/rideZoom";

import { INTRO_CLOSED, MAIN_MAP_CANVAS, installApiMocks, installMapFinder, seedStoredState } from "./fixtures";
import {
  START,
  buttonLook,
  coneDirection,
  deliverPosition,
  dotOffsetFrom,
  expectDrawnAt,
  mapBearing,
  screenPointOf,
  settledScreenPoint,
} from "./rideMap";

// 走行モードで、ブラウザが届ける位置の変化が実際の地図の動き（中心・向き）まで届くこと（パターン4 観点2）。単体テストの地図は
// 代役で、カメラを動かさない。走行モードの移り変わり（休む・戻す・止める）の判断は useRideMode.test.ts が持ち、ここでは
// それが地図に現れるかだけを見る。位置はブラウザの位置の差し替え（`setGeolocation`）で届け、向きを持たせない（動いた向きから出る）。

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
      .toBeCloseTo(RIDE_ZOOM_STEPS[0].zoom - RIDE_ZOOM_MAX_OUT, 1);
  }

  // 進む向きを上にすると、地図は動いた向き（東）を上に回す。北を上に戻すと向きも戻る。
  await page.getByRole("button", { name: /^進む向きを上にする/ }).click();
  await expect.poll(() => mapBearing(page), { timeout: 10_000 }).toBeCloseTo(90, 0);
  await page.getByRole("button", { name: /^北を上にする/ }).click();
  await expect.poll(() => mapBearing(page), { timeout: 10_000 }).toBeCloseTo(0, 0);

  // 指で地図を動かすと追うのを休み、次の位置が届いても地図は動かない（点だけが動く）。
  const canvas = (await page.locator(MAIN_MAP_CANVAS).boundingBox())!;
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

  // 東へ進んでから進む向きを上にしたまま止めると、地図を北が上へ戻し、点は最後に走った位置に残り（出発地はそこに無い）、次の位置が届いても
  // 地図も点も動かない。
  const lastRidden = moved(pausedAt, 0, 200);
  await deliverPosition(page, context, lastRidden);
  await page.getByRole("button", { name: /^進む向きを上にする/ }).click();
  await expect.poll(() => mapBearing(page), { timeout: 10_000 }).toBeCloseTo(90, 0);
  await rideButton.click();
  await page.getByRole("button", { name: "案内を終える" }).click();
  await expect(rideButton).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => mapBearing(page), { timeout: 10_000 }).toBeCloseTo(0, 0);
  await expect.poll(() => dotOffsetFrom(page, lastRidden), { timeout: 10_000 }).toBeLessThan(2);
  const afterStop = moved(lastRidden, 0, 200);
  // 止めると左のパネルが戻って地図の幅が変わるので、落ち着いた位置を基準にする。
  const before = await settledScreenPoint(page, lastRidden);
  await deliverPosition(page, context, afterStop);
  const after = await screenPointOf(page, lastRidden);
  expect(after).not.toBeNull();
  expect(Math.hypot(after!.x - before.x, after!.y - before.y)).toBeLessThan(1);
  expect(await dotOffsetFrom(page, lastRidden)).toBeLessThan(2);
});
