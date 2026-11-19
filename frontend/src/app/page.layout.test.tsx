/**
 * `app/page.tsx`——トップページの画面の枠（地図の上の操作・ヘッダー・メニュー）。
 *
 * 見ること: 地図の表示をまとめて戻す操作（「表示」の一覧の末尾と右上のメニュー）、地図を読み込み中の札が基礎地図の描けたときに外れること（俯瞰図も）、
 * 層の取得状態の数え直しと再描画の失敗の案内、「表示」の「範囲と色」で地図を暗くすること（基礎地図の色を暗くし、描き直しても保ち、
 * 覚える）、区分の開閉の保存、左下の俯瞰図（気象の層を出して寄せると出て、道路を消した下地に同じ気象の層を描き、引くと消え、
 * 畳んだことを覚える）。
 *
 * ここで見ないもの: スマホの下部タブとシートは`app/page.mobile.test.tsx`が、右上の方位磁針と拡大・縮小は
 * `app/page.compass.test.tsx`が、ヘッダーとメニューは`app/page.header.test.tsx`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HOUR_MS } from "@/lib/duration";
import { onBackend } from "@/testing/backendServer";
import { ROAD_CLASS_COLOR, renderHome, section, serveHome, showRoadSurface } from "@/testing/homePage";
import { themedPaint } from "@/features/map/basemapTheme";
import { LAYER_DATA_STATUS_LABELS } from "@/features/map/layers/mapLayers";
import { LIBERTY_POI_LAYERS } from "@/testing/libertyPoiLayers";
import { insetMapOnScreen, mapOnScreen } from "@/testing/maplibre";

import Home from "./page";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

beforeEach(() => {
  serveHome();
});

describe("画面の枠", () => {
  it("地図の表示をまとめて戻す: 「表示」の一覧で行を全部消すとルートのほかの地図のレイヤーが消え、その一覧の絞り込みの解除は「負担で塗る」の凡例を数えず、そちらは「負担で塗る」の解除で戻す。右上のメニューの再描画は地図の描き直しを求める", async () => {
    const { user } = renderHome();
    const fromList = async <T,>(name: string, inspect: (button: HTMLButtonElement) => Promise<T> | T) => {
      await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
      const result = await inspect(screen.getByRole("button", { name }) as HTMLButtonElement);
      await user.keyboard("{Escape}");
      return result;
    };
    const canRun = (name: string) => fromList(name, (button) => !button.disabled);
    const run = (name: string) => fromList(name, (button) => user.click(button));
    // ルートの線は一覧の先頭の行が出し入れし、まとめて消す操作では消さない。
    const nonRouteLayers = () =>
      mapOnScreen()
        .visibleLayerIds()
        .filter((id) => !id.startsWith("route-"));
    await showRoadSurface(user);
    expect(nonRouteLayers()).not.toEqual([]);
    const routeLayers = mapOnScreen()
      .visibleLayerIds()
      .filter((id) => id.startsWith("route-"));
    await run("表示中の情報をすべて非表示");
    expect(nonRouteLayers()).toEqual([]);
    expect(mapOnScreen().visibleLayerIds()).toEqual(routeLayers);

    expect(await canRun("絞り込みをすべて解除")).toBe(false);
    await user.click(screen.getByRole("button", { name: /^負担で塗る: / }));
    await user.click(await screen.findByRole("radio", { name: /登坂/ }));
    await user.click(screen.getByRole("button", { name: "登坂の凡例" }));
    await user.click(await screen.findByRole("checkbox", { name: "凡例の全段階をまとめて表示/非表示" }));
    await user.keyboard("{Escape}");
    expect(await canRun("絞り込みをすべて解除")).toBe(false);
    await user.click(screen.getByRole("button", { name: /^負担で塗る: / }));
    await user.click(screen.getByRole("button", { name: "絞り込みをすべて解除" }));
    expect(screen.getByRole("button", { name: "絞り込みをすべて解除" })).toBeDisabled();
    await user.keyboard("{Escape}");

    const before = mapOnScreen().styles.length;
    await user.click(screen.getByRole("button", { name: "メニュー" }));
    await user.click(screen.getByRole("button", { name: "地図の表示を再描画" }));
    expect(mapOnScreen().styles).toHaveLength(before + 1);
  });

  it("地図の中央の「地図を読み込み中…」の札は、時間では外れず、基礎地図が描けた（`load`）ときに外れる", () => {
    vi.useFakeTimers();
    try {
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
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    const row = screen.getByRole("checkbox", { name: "路面の種類" }).closest("label");
    expect(row?.getAttribute("title")).toContain(LAYER_DATA_STATUS_LABELS.loading);
  });

  it("再描画でスタイルが取れなかったら読み込みの失敗を出し、もう一度押すと取り直し、取れたら消す。取り直しの間のタイル1枚の失敗では出さない", async () => {
    const { user } = renderHome();
    const failure = () => screen.queryByText(/地図の読み込みに失敗しました/);
    const redraw = async () => {
      await user.click(screen.getByRole("button", { name: "メニュー" }));
      await user.click(screen.getByRole("button", { name: "地図の表示を再描画" }));
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
      await fromMenu("地図の表示を再描画");
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

  it("区分の開閉は、次に開いたときも同じになる", async () => {
    const { user, unmount } = renderHome();
    await user.click(section("ルート設定"));
    unmount();

    renderHome();
    expect(section("ルート設定")).toHaveAttribute("aria-expanded", "false");
    expect(section("ルート結果")).toHaveAttribute("aria-expanded", "true");
  });

  it("気象の層を出して寄せると、左下に道路を消した俯瞰図が出て同じ気象の層を描き、引くと消える。「×」で丸いボタンに畳み、次に開いたときも畳んだまま", async () => {
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
    const { user, unmount } = renderHome();
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("checkbox", { name: "風[矢印]" }));
    await user.keyboard("{Escape}");
    const near = { west: 139.68, south: 35.69, east: 139.72, north: 35.71 };
    act(() => mapOnScreen().moveTo(near, 12));
    expect(await screen.findByRole("region", { name: "俯瞰図" })).toBeInTheDocument();
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

    act(() => mapOnScreen().moveTo(near, 10));
    expect(screen.queryByRole("region", { name: "俯瞰図" })).toBeNull();
    act(() => mapOnScreen().moveTo(near, 12));
    await user.click(await screen.findByRole("button", { name: "俯瞰図を畳む" }));
    expect(screen.queryByRole("region", { name: "俯瞰図" })).toBeNull();
    unmount();

    const again = renderHome();
    act(() => mapOnScreen().moveTo(near, 12));
    await again.user.click(await screen.findByRole("button", { name: "俯瞰図を開く" }));
    expect(screen.getByRole("region", { name: "俯瞰図" })).toBeInTheDocument();
  });
});
