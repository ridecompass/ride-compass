/**
 * `app/page.tsx`——トップページの右の列の、Street View の矢印。
 *
 * 見ること: 右の列のボタンで画面の真ん中に矢印を出し、向きは真ん中の近くを通るルートの進む向き、通らなければ画面の上にすること。
 * 点をつまんで地点を、つまみを回して（鍵盤でも）向きを変えると、帯の「ストリートビューを開く」がその地点と向きを開くこと（Android では
 * アプリへ向きが届く`intent:`）。「やめる」とボタンの押し直しでしまうこと。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { LOOP_CONDITIONS, candidateTabs, generate, renderHome, route, serveHome } from "@/testing/homePage";
import { mapOnScreen } from "@/testing/maplibre";
import { routeThrough } from "@/testing/routeFixtures";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

/** 描画面（窓いっぱい）に映す範囲。真ん中は北緯35.70・東経139.70。 */
const VIEW = { west: 139.69, south: 35.69, east: 139.71, north: 35.71 };

describe("Street View の矢印", () => {
  const aimButton = () => screen.getByRole("button", { name: "ストリートビューの地点と向きを決める" });
  const bar = () => screen.queryByRole("group", { name: "ストリートビューの地点と向き" });
  const handle = () => screen.getByRole("slider", { name: "ストリートビューの向き" });
  const aimMark = () => {
    const marks = mapOnScreen()
      .markers()
      .filter((mark) => mark.element.querySelector('[role="slider"]') !== null);
    return marks.length === 0 ? null : marks[0];
  };
  const openLink = () => within(bar()!).getByRole("link", { name: "ストリートビューを開く" });
  /** 要素を描画面の上の位置`from`（px）でつまみ、`[x, y]`へ動かす。 */
  const drag = (element: Element, from: [number, number], [x, y]: [number, number]) => {
    fireEvent.pointerDown(element, { pointerId: 1, clientX: from[0], clientY: from[1] });
    fireEvent.pointerMove(element, { pointerId: 1, clientX: x, clientY: y });
    fireEvent.pointerUp(element, { pointerId: 1 });
  };

  it("真ん中をルートが通れば進む向きで矢印を出し、点で地点を、つまみで向きを変えると帯のリンクがそこを開き、Android では intent: で開き、やめるとしまう", async () => {
    const { user } = renderHome();
    act(() => mapOnScreen().moveTo(VIEW, 15));
    // 真ん中を東へ通るルート。
    jobs.respond(
      [route("east", routeThrough({ a: [139.69, 35.7], b: [139.71, 35.7] }, ["a", "b"], [1]))],
      LOOP_CONDITIONS,
    );
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));

    await user.click(aimButton());
    expect(aimButton()).toHaveAttribute("aria-pressed", "true");
    expect(aimMark()).toMatchObject({ coordinates: { latitude: 35.7, longitude: 139.7 }, screenRotationDeg: 90 });
    expect(openLink()).toHaveAttribute("target", "_blank");

    // 点を、真ん中から右下へ10px外れた所でつまんで動かし、点を描画面の右上の4分の1の所へ置く（点は掴んだ所からの隔たりを保つ）。
    // つまみは点の真下へ回す。
    const [width, height] = [window.innerWidth, window.innerHeight];
    drag(
      screen.getByLabelText("ストリートビューを開く地点"),
      [width / 2 + 10, height / 2 + 10],
      [width * 0.75 + 10, height * 0.25 + 10],
    );
    drag(handle(), [0, 0], [width * 0.75, height * 0.25 + 100]);
    // 換算の行き来で最下位の桁がずれるので、地点と向きは小数6桁で比べる。
    expect(aimMark()).toMatchObject({
      coordinates: { latitude: expect.closeTo(35.705, 6), longitude: expect.closeTo(139.705, 6) },
      screenRotationDeg: expect.closeTo(180, 6),
    });
    const mapsUrl = "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=35.705000%2C139.705000&heading=180";
    expect(openLink()).toHaveAttribute("href", mapsUrl);

    // Android では、鍵盤の矢印で15度回した向きを、アプリへの intent で渡す（開けなければ同じ地点の Maps URLs）。
    const android = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Linux; Android 14; Pixel 8)");
    onTestFinished(() => android.mockRestore());
    handle().focus();
    await user.keyboard("{ArrowRight}");
    expect(openLink()).toHaveAttribute(
      "href",
      "intent:cbll=35.705000,139.705000&cbp=0,195,0,0,0#Intent;scheme=google.streetview;package=com.google.android.apps.maps;" +
        `S.browser_fallback_url=${encodeURIComponent(mapsUrl.replace("heading=180", "heading=195"))};end`,
    );

    await user.click(within(bar()!).getByRole("button", { name: "やめる" }));
    expect(aimMark()).toBeNull();
    expect(bar()).toBeNull();
  });

  it("真ん中の近くをルートが通らなければ、回した地図の画面の上へ向けて出し、ボタンを押し直すとしまう", async () => {
    const { user } = renderHome();
    act(() => mapOnScreen().rotateByHand(30));
    act(() => mapOnScreen().moveTo(VIEW, 15));

    await user.click(aimButton());
    expect(aimMark()).toMatchObject({ screenRotationDeg: 0 });
    expect(openLink()).toHaveAttribute(
      "href",
      "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=35.700000%2C139.700000&heading=30",
    );

    await user.click(aimButton());
    expect(aimMark()).toBeNull();
    expect(bar()).toBeNull();
  });
});
