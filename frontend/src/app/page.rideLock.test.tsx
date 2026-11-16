/**
 * `app/page.tsx`——トップページの走行モードのうち、ロック。鍵のボタンでロックすると追い直して地図の手ぶりと押しを受けず、
 * 2か所を順に押すと外れること、ロックしていても「表示」で地図の色を暗くできること。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stopRideTrack } from "@/lib/rideTrack";
import { installGeolocation } from "@/testing/geolocation";
import {
  ELSEWHERE,
  HERE,
  LOOP_CONDITIONS,
  RIDDEN,
  RIDDEN_MIDDLE,
  candidateTabs,
  clickMap,
  clickSegment,
  generate,
  renderHome,
  serveHome,
} from "@/testing/homePage";
import { UNLOCK_CHOICE_MS } from "@/features/ride/RideLockButton/RideLockButton";
import { mapOnScreen } from "@/testing/maplibre";
import { themedPaint } from "@/features/map/basemapTheme";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

afterEach(() => {
  stopRideTrack(Date.now());
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("走行中のロック", () => {
  it("走行中に鍵のボタンでロックすると、地図を指で動かして休んでいれば追い直し、地図の手ぶりの操作を止め、地図を押しても何も開かず閉じない。鍵を押して横に出る「ロックを外す」を押すと外れ、選ばずにいると時間で閉じ、案内を終えるとロックも外れる", async () => {
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");
    const rideButton = () => screen.getByRole("button", { name: "走行モード" });
    const lockButton = () => screen.getByRole("button", { name: "ロック" });
    const backToHere = () => screen.queryByRole("button", { name: "現在地へ戻る" });
    const unlockChoice = () => screen.queryByRole("button", { name: "ロックを外す" });
    const segmentPopup = () => screen.queryByRole("group", { name: "区間の小窓の上の帯" });
    // 走っていない間は鍵を出さない。
    expect(screen.queryByRole("button", { name: "ロック" })).toBeNull();
    await user.click(rideButton());
    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    clickSegment(drawnSegment, HERE);
    expect(segmentPopup()).toBeInTheDocument();
    act(() => mapOnScreen().emit("movestart", { originalEvent: new MouseEvent("mousedown") }));
    expect(backToHere()).toBeInTheDocument();

    await user.click(lockButton());
    expect(lockButton()).toHaveAttribute("aria-pressed", "true");
    expect(rideButton()).toHaveAttribute("data-ride", "following");
    expect(backToHere()).toBeNull();
    // 指の操作が地図を動かさないかは実ブラウザの MapLibre でしか出ないので、e2e/ride-mode-touch.spec.ts が指を送って見る。
    expect(mapOnScreen().stoppedGestures()).toEqual(
      expect.arrayContaining(["dragPan", "touchZoomRotate", "doubleClickZoom"]),
    );
    // 開いていた小窓は、地図の外れを押しても閉じず、ほかの物を押しても開かない。
    clickMap(ELSEWHERE);
    expect(segmentPopup()).toBeInTheDocument();

    // 鍵を押すと外す選びを出し、選ばずにいると時間で閉じてロックのまま。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(lockButton());
      expect(unlockChoice()).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(UNLOCK_CHOICE_MS));
      expect(unlockChoice()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    expect(lockButton()).toHaveAttribute("aria-pressed", "true");

    await user.click(lockButton());
    await user.click(unlockChoice()!);
    expect(lockButton()).toHaveAttribute("aria-pressed", "false");
    expect(mapOnScreen().stoppedGestures()).toEqual([]);

    // ロックして案内を終え、また始めるとロックしていない。
    await user.click(lockButton());
    await user.click(rideButton());
    await user.click(screen.getByRole("button", { name: "案内を終える" }));
    expect(mapOnScreen().stoppedGestures()).toEqual([]);
    await user.click(rideButton());
    expect(lockButton()).toHaveAttribute("aria-pressed", "false");
  });

  it("走行中にロックしていても、「表示」の「範囲と色」で地図の色を暗いにでき、基礎地図が暗くなる", async () => {
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const basemap = [{ id: "background", type: "background", paint: { "background-color": "#f8f4f0" } }];
    // 基礎地図の色は、描き直して読み込んだ基礎地図の様式に当てる。
    await user.click(screen.getByRole("button", { name: "メニュー" }));
    await user.click(screen.getByRole("button", { name: "地図の表示を再描画" }));
    act(() => {
      mapOnScreen().loadStyle(basemap);
      mapOnScreen().emit("style.load");
    });
    await user.click(screen.getByRole("button", { name: "走行モード" }));
    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    await user.click(screen.getByRole("button", { name: "ロック" }));

    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("tab", { name: "範囲と色" }));
    await user.click(screen.getByRole("radio", { name: "暗い" }));

    expect(mapOnScreen().layerPaint("background")?.["background-color"]).toBe(
      themedPaint({ theme: "dark", muted: false }, basemap[0].paint)["background-color"],
    );
  });
});
