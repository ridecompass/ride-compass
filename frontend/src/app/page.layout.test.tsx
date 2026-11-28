/**
 * `app/page.tsx`——トップページの画面の枠（地図の上の操作・ヘッダー・メニュー）。
 *
 * 見ること: 地図の表示をまとめて戻す操作（「表示」の一覧の末尾と右上のメニュー）、地図を読み込み中の札が基礎地図の描けたときに外れること（俯瞰図も）、
 * 層の取得状態の数え直しと再描画の失敗の案内、「表示」の「範囲と色」で地図を暗くすること（基礎地図の色を暗くし、描き直しても保ち、
 * 覚え、開き直すと本体の地図も俯瞰図も基礎地図が描ける前から暗い）、区分の開閉の保存、左下の俯瞰図（気象の層を出して寄せると、はじめは畳んだボタンが出て、開くと道路を消した下地に同じ気象の層を描き、
 * 引くと消え、開け閉めを覚える）。
 *
 * ここで見ないもの: スマホの下部タブとシートは`app/page.mobile.test.tsx`が、右上の方位磁針と拡大・縮小は
 * `app/page.compass.test.tsx`が、ヘッダーとメニューは`app/page.header.test.tsx`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HOUR_MS } from "@/lib/duration";
import { onBackend } from "@/testing/backendServer";
import {
  ROAD_CLASS_COLOR,
  renderHome,
  section,
  serveHome,
  showRoadSurface,
  signedInAndConsented,
} from "@/testing/homePage";
import { themedPaint } from "@/features/map/basemapTheme";
import { LAYER_DATA_STATUS_LABELS } from "@/features/map/layers/mapLayers";
import { LOADING_STATUS_DELAY_MS } from "@/features/map/useShownDataStatus";
import { LIBERTY_POI_LAYERS } from "@/testing/libertyPoiLayers";
import { insetMapOnScreen, mapOnScreen } from "@/testing/maplibre";

import Home from "./page";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

beforeEach(() => {
  serveHome();
});

/** 俯瞰図を出す範囲（寄せた本体の地図）と、そこへ吹く風の予報を配る。 */
const NEAR = { west: 139.68, south: 35.69, east: 139.72, north: 35.71 };

function serveWind() {
  // 時刻は日本時間の壁時計で、今の時刻を含む1時間から2日分。
  const times = Array.from(
    { length: 48 },
    (_, hour) => new Date(Date.now() + (9 + hour) * HOUR_MS).toISOString().slice(0, 13) + ":00",
  );
  onBackend("GET", "/api/weather/msm-grid", () =>
    Response.json({
      times,
      latitude_step_deg: 0.05,
      longitude_step_deg: 0.0625,
      points: [
        {
          latitude: 35.7,
          longitude: 139.7,
          wind_speed_ms: times.map(() => 6),
          wind_direction_deg: times.map(() => 90),
          precipitation_mm: times.map(() => 0),
        },
      ],
    }),
  );
}

describe("画面の枠", () => {
  it("地図の表示をまとめて戻す: 「表示」の一覧で行を全部消すと、一覧の外のもの（ルートの線・起伏の陰影）のほかの地図のレイヤーが消える", async () => {
    const { user } = renderHome();
    const fromList = async <T,>(name: string, inspect: (button: HTMLButtonElement) => Promise<T> | T) => {
      await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
      const result = await inspect(screen.getByRole("button", { name }) as HTMLButtonElement);
      await user.keyboard("{Escape}");
      return result;
    };
    const run = (name: string) => fromList(name, (button) => user.click(button));
    // 一覧の外のもの（ルートの線・起伏の陰影）は、まとめて消す操作では消さない。
    const outsideList = mapOnScreen().visibleLayerIds();
    await showRoadSurface(user);
    expect(mapOnScreen().visibleLayerIds()).not.toEqual(outsideList);
    await run("表示中の情報をすべて非表示");
    expect(mapOnScreen().visibleLayerIds()).toEqual(outsideList);
  });

  it("地図の中央の「地図を読み込み中…」の札は、時間では外れず、基礎地図が描けた（`load`）ときに外れる", () => {
    vi.useFakeTimers();
    try {
      signedInAndConsented();
      render(<Home />);
      act(() => vi.runOnlyPendingTimers());
      expect(screen.getByText("地図を読み込み中…")).toBeInTheDocument();
      act(() => mapOnScreen().emit("load"));
      expect(screen.queryByText("地図を読み込み中…")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("地図の出来事のたびに数え直す層の取得状態は、画面の設定が届いてから足された道の層も数える", async () => {
    const { user } = renderHome();
    await showRoadSurface(user);
    act(() => mapOnScreen().emit("idle"));
    // 待ちの印を出すまでの長さを、偽の時計で進める（実時間で待つと、この画面のテストはメモリを使い切る）。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(screen.getByRole("button", { name: "地図に出す情報" }));
      act(() => vi.advanceTimersByTime(LOADING_STATUS_DELAY_MS));
      const row = screen.getByRole("checkbox", { name: "路面の種類" }).closest("label");
      expect(row?.getAttribute("title")).toContain(LAYER_DATA_STATUS_LABELS.loading);
    } finally {
      vi.useRealTimers();
    }
  });

  it("再描画でスタイルが取れなかったら読み込みの失敗を出し、もう一度押すと取り直し、取れたら消す。取り直しの間のタイル1枚の失敗では出さない", async () => {
    const { user } = renderHome();
    const failure = () => screen.queryByText(/地図の読み込みに失敗しました/);
    const redraw = async () => {
      await user.click(screen.getByRole("button", { name: "メニュー" }));
      await user.click(screen.getByRole("button", { name: "地図を描き直す" }));
    };
    const before = mapOnScreen().styles.length;
    await redraw();
    act(() => mapOnScreen().emit("error", { error: new Error("タイル1枚の失敗"), sourceId: "road-tiles" }));
    expect(failure()).toBeNull();
    // MapLibreは取り直しの要求の失敗を、取りに行ったURLを持つ出来事で知らせ、"style.load"は出さない。
    act(() => mapOnScreen().emit("error", { error: { url: mapOnScreen().styles.at(-1) } }));
    expect(failure()).toBeInTheDocument();

    await redraw();
    expect(mapOnScreen().styles).toHaveLength(before + 2);
    act(() => mapOnScreen().emit("style.load"));
    expect(failure()).toBeNull();
  });

  it("「表示」の「範囲と色」で地図の色を暗いにすると、基礎地図とアプリが重ねる線の色を暗い地用にし、地図を描き直しても暗いまま。明るいに戻すと明るい地図へ戻り、次に開いたときも選んだ色のまま", async () => {
    const { user, unmount } = renderHome();
    const basemap = [{ id: "background", type: "background", paint: { "background-color": "#f8f4f0" } }];
    const ground = () => mapOnScreen().layerPaint("background")?.["background-color"];
    const painted = (color: string) =>
      mapOnScreen()
        .visibleLayerIds()
        .some((id) => JSON.stringify(mapOnScreen().layerPaint(id) ?? {}).includes(color));
    const fromMenu = async (name: string) => {
      await user.click(screen.getByRole("button", { name: "メニュー" }));
      await user.click(screen.getByRole("button", { name }));
      await user.keyboard("{Escape}");
    };
    const chooseMapColor = async (name: string) => {
      await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
      await user.click(screen.getByRole("tab", { name: "範囲と色" }));
      await user.click(screen.getByRole("radio", { name }));
      await user.keyboard("{Escape}");
    };
    const redraw = async () => {
      await fromMenu("地図を描き直す");
      act(() => {
        mapOnScreen().loadStyle(basemap);
        mapOnScreen().emit("style.load");
      });
    };
    await redraw();
    await showRoadSurface(user);
    expect(ground()).toBe("#f8f4f0");
    expect(painted(ROAD_CLASS_COLOR.light)).toBe(true);

    await chooseMapColor("暗い");
    const dark = themedPaint({ theme: "dark", muted: false }, basemap[0].paint)["background-color"];
    expect(ground()).toBe(dark);
    expect([painted(ROAD_CLASS_COLOR.dark), painted(ROAD_CLASS_COLOR.light)]).toEqual([true, false]);
    await redraw();
    expect(ground()).toBe(dark);
    expect(painted(ROAD_CLASS_COLOR.dark)).toBe(true);

    await chooseMapColor("明るい");
    expect(ground()).toBe("#f8f4f0");
    expect([painted(ROAD_CLASS_COLOR.light), painted(ROAD_CLASS_COLOR.dark)]).toEqual([true, false]);
    await chooseMapColor("暗い");
    unmount();

    const again = renderHome();
    await again.user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await again.user.click(screen.getByRole("tab", { name: "範囲と色" }));
    expect(screen.getByRole("radio", { name: "暗い" })).toBeChecked();
  });

  it("地図の色を暗いにして開き直すと、基礎地図が描ける（`load`）前のスタイルが読めた時点で、本体の地図も俯瞰図も基礎地図が暗い", async () => {
    serveWind();
    const basemap = [{ id: "background", type: "background", paint: { "background-color": "#f8f4f0" } }];
    const dark = themedPaint({ theme: "dark", muted: false }, basemap[0].paint)["background-color"];
    const { user, unmount } = renderHome();
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("checkbox", { name: "風" }));
    await user.click(screen.getByRole("tab", { name: "範囲と色" }));
    await user.click(screen.getByRole("radio", { name: "暗い" }));
    await user.keyboard("{Escape}");
    act(() => mapOnScreen().moveTo(NEAR, 12));
    await user.click(await screen.findByRole("button", { name: "俯瞰図を開く" }));
    unmount();

    render(<Home />);
    act(() => {
      mapOnScreen().loadStyle(basemap);
      mapOnScreen().emit("style.load");
    });
    expect(mapOnScreen().layerPaint("background")?.["background-color"]).toBe(dark);
    act(() => mapOnScreen().emit("load"));
    act(() => mapOnScreen().moveTo(NEAR, 12));
    await screen.findByRole("region", { name: "俯瞰図" });
    const inset = insetMapOnScreen()!;
    act(() => {
      inset.loadStyle(basemap);
      inset.emit("style.load");
    });
    expect(inset.layerPaint("background")?.["background-color"]).toBe(dark);
  });

  it("区分の開閉は、次に開いたときも同じになる", async () => {
    const { user, unmount } = renderHome();
    await user.click(section("ルート設定"));
    unmount();

    renderHome();
    expect(section("ルート設定")).toHaveAttribute("aria-expanded", "false");
    expect(section("ルート結果")).toHaveAttribute("aria-expanded", "true");
  });

  it("気象の層を出して寄せると、左下に道路を消した俯瞰図が出て同じ気象の層を描き、引くと消える。俯瞰図の読み込み中の札は、描けたときか描ける前の失敗で外れる。はじめは丸いボタンに畳んでいて、開くと出て、開け閉めを次に開いたときも覚えている", async () => {
    serveWind();
    const { user, unmount } = renderHome();
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("checkbox", { name: "風" }));
    await user.keyboard("{Escape}");
    act(() => mapOnScreen().moveTo(NEAR, 12));
    await user.click(await screen.findByRole("button", { name: "俯瞰図を開く" }));
    const inset = insetMapOnScreen()!;
    const insetLoading = () =>
      within(screen.getByRole("region", { name: "俯瞰図" })).queryByText("俯瞰図を読み込み中…");
    expect(insetLoading()).toBeInTheDocument();
    act(() => inset.loadStyle(LIBERTY_POI_LAYERS));
    act(() => inset.emit("load"));
    expect(insetLoading()).toBeNull();
    const weatherOnMain = () =>
      mapOnScreen()
        .visibleLayerIds()
        .filter((id) => inset.visibleLayerIds().includes(id));
    await waitFor(() => expect(weatherOnMain()).not.toEqual([]));
    // 俯瞰図に描くのは基礎地図の道路・店を除いたものと、本体の地図と同じ気象の層だけ。
    expect(inset.visibleLayerIds()).toEqual(weatherOnMain());

    act(() => mapOnScreen().moveTo(NEAR, 10));
    expect(screen.queryByRole("region", { name: "俯瞰図" })).toBeNull();
    act(() => mapOnScreen().moveTo(NEAR, 12));
    expect(await screen.findByRole("region", { name: "俯瞰図" })).toBeInTheDocument();
    unmount();

    const again = renderHome();
    act(() => mapOnScreen().moveTo(NEAR, 12));
    expect(await screen.findByText("俯瞰図を読み込み中…")).toBeInTheDocument();
    act(() => insetMapOnScreen()!.emit("error", { error: new Error("スタイルが取れない") }));
    expect(insetLoading()).toBeNull();
    await again.user.click(await screen.findByRole("button", { name: "俯瞰図を畳む" }));
    expect(screen.queryByRole("region", { name: "俯瞰図" })).toBeNull();
    expect(screen.getByRole("button", { name: "俯瞰図を開く" })).toBeInTheDocument();
  });
});
