import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { moved } from "@/testing/movedPoint";

import { MAIN_MAP_CANVAS, MOBILE_VIEWPORT, openMapApp } from "./fixtures";
import { START, deliverPosition, expectDrawnAt, settledScreenPoint, settledZoom } from "./rideMap";

// 2本指でつまむ・広げる操作は、MapLibre が先に指の重心のずれを移動として受け、倍率が変わるのはそのあとになり、指がひねれば
// 回し始める。出来事の並び（移動の始まり→拡大の始まり）と回すかどうかは実ブラウザの MapLibre でしか出ないので、ここで
// 指ごとのタッチを送って見る（パターン4 観点2）。倍率のボタンが地図の倍率まで届くことも、速さを0にできるここで見る。
test.describe("タッチ端末", () => {
  test.use({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });

  test("走行モードで追っている間、倍率のボタンで基準の倍率が段を回り、2本指でひねりながらつまんでも地図は回らず、休まずにその倍率で追い続け、つまむ最中に位置が届いても倍率を戻さず、1本指で動かすと休む", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "指ごとのタッチの列はCDP（Chromiumだけの口）でしか送れない");
    // 誤差の内の動きは地図へ流れないので、誤差を小さくし、それを超える数mずつの動きで届ける。動きは時速15km（倍率に速さの
    // 引きが混ざり始める速さ。`rideZoom.ts: RIDE_ZOOM_SLOW_KMH`）に届かない遅さに保つ。
    const at = (point: { latitude: number; longitude: number }) => ({ ...point, accuracy: 1 });
    await openMapApp(page, { routes: () => context.setGeolocation(at(START)) });
    await page.getByRole("button", { name: "走行モード" }).click();
    const anchor = await settledScreenPoint(page, START);
    const zoom = () => page.evaluate(() => window.__liveMap().getZoom());
    const backToHere = page.getByRole("button", { name: "現在地へ戻る" });

    // 走っている間の倍率のボタンは、押すたびに中→遠→近→中と基準の倍率を替える（速さ0なので引かない）。
    const zoomButton = page.getByRole("button", { name: /^倍率/ });
    expect(await settledZoom(page)).toBeCloseTo(17, 2);
    for (const expected of [15, 18, 17]) {
      await zoomButton.click();
      expect(await settledZoom(page)).toBeCloseTo(expected, 2);
    }
    await expectDrawnAt(page, START, anchor);
    await expect(backToHere).toBeHidden();
    const followedZoom = await zoom();

    const { touch, release, center, dragOneFinger } = await fingersOnMap(page, context);
    const fingers = (gap: number, dx: number, turnDeg: number) => {
      const [x, y] = [Math.cos((turnDeg * Math.PI) / 180) * (gap / 2), Math.sin((turnDeg * Math.PI) / 180) * (gap / 2)];
      return [
        { x: center.x + dx - x, y: center.y - y },
        { x: center.x + dx + x, y: center.y + y },
      ];
    };

    // 指の間を240pxから80pxへ縮めながら、指の並びを45度ひねる（MapLibre が回し始める、指の間の弧で25pxを超える）。
    // 先に重心だけを横へ動かし、移動として始まらせる。
    const [fromGap, toGap, turnDeg, steps] = [240, 80, 45, 10];
    const gapAt = (step: number) => fromGap + ((toGap - fromGap) * step) / steps;
    const turnAt = (step: number) => (turnDeg * step) / steps;
    await touch("touchStart", fingers(fromGap, 0, 0));
    await touch("touchMove", fingers(fromGap, 6, 0));
    for (let step = 1; step <= steps / 2; step += 1) await touch("touchMove", fingers(gapAt(step), 6, turnAt(step)));
    // つまむ最中に届いた位置で、倍率を元へ戻さず、つまむ操作も止めない。
    const duringPinch = moved(START, 0, 10);
    await deliverPosition(page, context, at(duringPinch));
    for (let step = steps / 2 + 1; step <= steps; step += 1)
      await touch("touchMove", fingers(gapAt(step), 6, turnAt(step)));
    // 指を離すと北が上へ寄せ直すので、回っていないことは指を置いたまま見る。
    expect(await page.evaluate(() => window.__liveMap().getBearing())).toBeCloseTo(0, 1);
    await release();

    // 指を離したあとの慣性で倍率がどれだけ進むかは指の動きの速さで変わるので、落ち着いた倍率を読む。つまむ前の倍率へ
    // 戻していれば、つまんだ分（log2(3) 段から、拡大・縮小と見なすまでの遊びを引いた分）だけ下がっていない。
    const pinchedZoom = await settledZoom(page);
    expect(followedZoom - pinchedZoom).toBeGreaterThan(1);
    // 休まず、つまむ最中に届いた位置へ寄せ直し、次の位置もつまんだ倍率のまま追う。
    await expectDrawnAt(page, duringPinch, anchor);
    await expect(backToHere).toBeHidden();
    const next = moved(START, 0, 13);
    await deliverPosition(page, context, at(next));
    await expectDrawnAt(page, next, anchor);
    expect(await zoom()).toBeCloseTo(pinchedZoom, 2);
    await expect(backToHere).toBeHidden();

    // 1本指でたたいてから触れたまま滑らせる拡大・縮小でも休まない。
    const beforeTapDrag = await zoom();
    await touch("touchStart", [center]);
    await release();
    await touch("touchStart", [center]);
    for (let step = 1; step <= 10; step += 1) await touch("touchMove", [{ x: center.x, y: center.y + step * 10 }]);
    await release();
    expect(Math.abs((await settledZoom(page)) - beforeTapDrag)).toBeGreaterThan(0.5);
    await expect(backToHere).toBeHidden();

    // 1本指で動かすと休む。
    await dragOneFinger();
    await expect(backToHere).toBeVisible();
  });

  // ロックで地図の手ぶりを止めたとき、指のタッチが地図を動かさず倍率も変えないかは、実ブラウザの MapLibre に指を送ってしか
  // 出ない（パターン4 観点2）。押しを受けないことと鍵の入切は app/page.rideControl.test.tsx が見る。
  test("走行モードでロックしている間は、1本指で動かしても2本指でつまんでも2回たたいても地図は動かず倍率も変わらずに追い続け、ロックを外すと1本指で動かして休める", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "指ごとのタッチの列はCDP（Chromiumだけの口）でしか送れない");
    await openMapApp(page, { routes: () => context.setGeolocation({ ...START, accuracy: 50 }) });
    await page.getByRole("button", { name: "走行モード" }).click();
    const anchor = await settledScreenPoint(page, START);
    const zoom = await settledZoom(page);
    const backToHere = page.getByRole("button", { name: "現在地へ戻る" });
    await page.getByRole("button", { name: "ロック" }).click();

    const { touch, release, center, dragOneFinger } = await fingersOnMap(page, context);

    await dragOneFinger();
    for (let step = 0; step <= 10; step += 1) {
      const gap = 80 + step * 16;
      await touch(step === 0 ? "touchStart" : "touchMove", [
        { x: center.x - gap / 2, y: center.y },
        { x: center.x + gap / 2, y: center.y },
      ]);
    }
    await release();
    for (let tap = 0; tap < 2; tap += 1) {
      await touch("touchStart", [center]);
      await release();
    }
    expect(await settledZoom(page)).toBeCloseTo(zoom, 2);
    await expectDrawnAt(page, START, anchor);
    await expect(backToHere).toBeHidden();

    await page.getByRole("button", { name: "ロック" }).click();
    await page.getByRole("button", { name: "ロックを外す" }).click();
    await dragOneFinger();
    await expect(backToHere).toBeVisible();
  });
});

/** 地図のcanvasの中心へ、指ごとのタッチ（CDP）を送る口。 */
async function fingersOnMap(page: Page, context: BrowserContext) {
  const client = await context.newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove", points: { x: number; y: number }[]) =>
    client.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, id) => ({ ...p, id })) });
  const release = () => client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const canvas = (await page.locator(MAIN_MAP_CANVAS).boundingBox())!;
  const center = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
  const dragOneFinger = async () => {
    await touch("touchStart", [center]);
    for (let step = 1; step <= 10; step += 1) await touch("touchMove", [{ x: center.x - step * 10, y: center.y }]);
    await release();
  };
  return { touch, release, center, dragOneFinger };
}
