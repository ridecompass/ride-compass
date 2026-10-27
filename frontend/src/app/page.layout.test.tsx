/**
 * `app/page.tsx`——トップページの画面の枠（地図の上の操作・ヘッダー・メニュー）。
 *
 * 見ること: 地図の表示をまとめて戻す操作（「表示」の一覧の末尾と右上のメニュー）、右上の方位磁針（地図の北を指し、
 * 開いたダイヤルで地図を回して北へ戻す。なぞる途中で閉じたら回さない）と拡大・縮小、地図を読み込み中の覆いが上限の時間で外れること、層の取得状態の数え直しと
 * 再描画の失敗の案内、区分の開閉の保存、左下の俯瞰図（気象の層を出して寄せると出て、道路を消した下地に同じ気象の層を描き、引くと消え、畳んだことを覚える）、
 * ヘッダーの「未取得」に並ぶ出所と「現在地に移動」の失敗、「現在地に移動」が出発地を変えずに地図を寄せて現在地に点を
 * 出すこと、メニューから入る使い方の説明（生成前の画面の「中を見る」で開いた浮きパネルの中の部品がどれも使い方の文を持つこと）とデバッグログ。
 *
 * ここで見ないもの: スマホの下部タブとシートは`app/page.mobile.test.tsx`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setDebugEnabled } from "@/lib/debugLog";
import { HOUR_MS, SECOND_MS } from "@/lib/duration";
import refreshIntervals from "@/types/generated/refresh-intervals.json";
import { heldReplies, onBackend } from "@/testing/backendServer";
import { installGeolocation } from "@/testing/geolocation";
import {
  ELSEWHERE,
  HERE,
  clickMap,
  marksAt,
  renderHome,
  section,
  serveHome,
  showRoadSurface,
  useMobileLayout,
} from "@/testing/homePage";
import {
  USAGE_OPENS_ATTRIBUTE,
  USAGE_PART_SELECTOR,
  isInUsageGuide,
  usageTargetOf,
} from "@/components/UsageGuide/usageTarget";
import { LAYER_DATA_STATUS_LABELS } from "@/features/map/layers/mapLayers";
import { LIBERTY_POI_LAYERS } from "@/testing/libertyPoiLayers";
import { insetMapOnScreen, mapOnScreen } from "@/testing/maplibre";

import Home from "./page";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

beforeEach(() => {
  serveHome();
});

afterEach(() => {
  setDebugEnabled(false);
});

describe("画面の枠", () => {
  it("地図の表示をまとめて戻す: 「表示」の一覧で行を全部消すとルートのほかの地図のレイヤーが消え、その一覧の絞り込みの解除は「評価で塗る」の凡例を数えず、そちらは「評価で塗る」の解除で戻す。右上のメニューの再描画は地図の描き直しを求める", async () => {
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
    await run("表示中のレイヤーをすべて非表示");
    expect(nonRouteLayers()).toEqual([]);
    expect(mapOnScreen().visibleLayerIds()).toEqual(routeLayers);

    expect(await canRun("絞り込みをすべて解除")).toBe(false);
    await user.click(screen.getByRole("button", { name: /^評価で塗る: / }));
    await user.click(await screen.findByRole("radio", { name: /軸A/ }));
    await user.click(screen.getByRole("button", { name: "軸Aの凡例" }));
    await user.click(await screen.findByRole("checkbox", { name: "凡例の全段階をまとめて表示/非表示" }));
    await user.keyboard("{Escape}");
    expect(await canRun("絞り込みをすべて解除")).toBe(false);
    await user.click(screen.getByRole("button", { name: /^評価で塗る: / }));
    await user.click(screen.getByRole("button", { name: "絞り込みをすべて解除" }));
    expect(screen.getByRole("button", { name: "絞り込みをすべて解除" })).toBeDisabled();
    await user.keyboard("{Escape}");

    const before = mapOnScreen().styles.length;
    await user.click(screen.getByRole("button", { name: "メニュー" }));
    await user.click(screen.getByRole("button", { name: "地図の表示を再描画" }));
    expect(mapOnScreen().styles).toHaveLength(before + 1);
  });

  it("右上の方位磁針は地図の北を指し、押すと開くダイヤルの輪をなぞる・矢印のキーで地図が回り、真ん中の針で北が上に戻る。ダイヤルの文は方位と度だけ。＋・－で拡大・縮小し、長押しで1本指の拡大・縮小の案内が出る", async () => {
    const { user } = renderHome();
    const compass = screen.getByRole("button", { name: "地図の向き" });
    const needleTurn = () => compass.querySelector<HTMLElement>("[style]")?.style.transform;

    act(() => mapOnScreen().rotateByHand(90));
    expect(needleTurn()).toBe("rotate(-90deg)");

    await user.click(compass);
    const dial = await screen.findByRole("slider", { name: "地図の向き" });
    expect(dial).toHaveAttribute("aria-valuetext", "E 90°");
    expect(screen.getByRole("dialog").textContent).toMatch(/^[A-Z0-9° ]+$/);
    dial.focus();
    await user.keyboard("{ArrowLeft}");
    expect(mapOnScreen().bearing()).toBe(85);
    // 輪の中心の真上から真右へ、時計回りに4分の1なぞると、指の下の方位が付いてくるよう地図は反時計回りに回る。
    const center = dial.getBoundingClientRect();
    const cx = center.left + center.width / 2;
    const cy = center.top + center.height / 2;
    fireEvent.pointerDown(dial, { clientX: cx, clientY: cy - 50 });
    fireEvent.pointerMove(window, { clientX: cx + 50, clientY: cy });
    fireEvent.pointerUp(window);
    expect(mapOnScreen().bearing()).toBe(355);
    expect(needleTurn()).toBe("rotate(-355deg)");
    await user.click(screen.getByRole("button", { name: "北を上にする" }));
    expect(mapOnScreen().bearing()).toBe(0);
    await user.keyboard("{Escape}");

    const zoom = mapOnScreen().zoom();
    await user.click(screen.getByRole("button", { name: "拡大" }));
    expect(mapOnScreen().zoom()).toBe(zoom + 1);
    await user.click(screen.getByRole("button", { name: "縮小" }));
    expect(mapOnScreen().zoom()).toBe(zoom);
    fireEvent.pointerDown(screen.getByRole("button", { name: "拡大" }), { pointerType: "touch", button: 0 });
    expect(await screen.findByRole("tooltip", {}, { timeout: 2000 })).toHaveTextContent(
      /続けて触れたまま上下に滑らせても拡大・縮小できます/,
    );
  });

  it("輪をなぞっている途中でダイヤルを閉じても、その後の指の動きで地図は回らない", async () => {
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "地図の向き" }));
    const dial = await screen.findByRole("slider", { name: "地図の向き" });
    const center = dial.getBoundingClientRect();
    fireEvent.pointerDown(dial, { clientX: center.left, clientY: center.top - 50 });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("slider", { name: "地図の向き" })).toBeNull();
    fireEvent.pointerMove(window, { clientX: center.left + 50, clientY: center.top });
    expect(mapOnScreen().bearing()).toBe(0);
  });

  it("基礎地図が描けず（`load`が来ず）ても、地図を読み込み中の覆いは上限の時間で外れる", () => {
    vi.useFakeTimers();
    try {
      render(<Home />);
      expect(screen.getByText("地図を読み込み中…")).toBeInTheDocument();
      act(() => vi.runOnlyPendingTimers());
      expect(screen.queryByText("地図を読み込み中…")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("地図の出来事のたびに数え直す層の取得状態は、軸カタログが届いてから足された道の層も数える", async () => {
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
    act(() => inset.loadStyle(LIBERTY_POI_LAYERS));
    act(() => inset.emit("load"));
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

  it("ヘッダーの「未取得」に、現在地・軸の一覧・警報の取れないものが並ぶ。「現在地に移動」が取れなければ地図の上に理由を出す", async () => {
    installGeolocation(null);
    onBackend("GET", "/api/axis-catalog", () => Response.json({ detail: "失敗" }, { status: 502 }));
    onBackend("GET", "/api/weather/warnings", () => Response.json({ detail: "失敗" }, { status: 502 }));
    const { user } = renderHome();
    const missing = () => screen.getByRole("button", { name: /を取得できていません。押すと/ });
    await waitFor(() => expect(missing()).toHaveAccessibleName(/現在地.*評価軸の一覧|評価軸の一覧.*現在地/));
    expect(missing()).not.toHaveAccessibleName(/警報/);

    await user.click(screen.getByRole("button", { name: "現在地に移動" }));
    expect(screen.getByText(/現在地を取得できませんでした/)).toBeInTheDocument();

    await clickMap(HERE);
    await waitFor(() => expect(missing()).toHaveAccessibleName(/警報/));
    expect(missing()).not.toHaveAccessibleName(/現在地/);
  });

  it("ヘッダーの観測値の失敗の印は、間隔ごとに取り直している間も出したままにする", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      onBackend("GET", "/api/weather/amedas", () => Response.json({ detail: "失敗" }, { status: 502 }));
      renderHome();
      const mark = () => screen.queryByRole("img", { name: "観測値を取得できません" });
      await waitFor(() => expect(mark()).not.toBeNull());

      const held = heldReplies();
      onBackend("GET", "/api/weather/amedas", held.reply);
      act(() => vi.advanceTimersByTime(refreshIntervals.amedas_seconds * SECOND_MS));
      await waitFor(() => expect(held.arrived()).toBe(1));
      expect(mark()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("「現在地に移動」は現在地を取り直して地図を寄せ、出発地は変えずに現在地に点を出す", async () => {
    const { user } = renderHome();
    await clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "現在地に移動" }));

    expect(marksAt(ELSEWHERE)).toHaveLength(1);
    expect(screen.getByRole("img", { name: "現在地" })).toBeInTheDocument();
    expect(marksAt(HERE).map(({ element }) => element.getAttribute("aria-label"))).toEqual(["現在地"]);
  });

  it("メニューから使い方の説明に入って「やめる」で抜け、デバッグログをメニューから開いてログの側から閉じられる", async () => {
    const { user } = renderHome();
    // 地図を開いたあとに入れる（代役の地図は基礎地図の道路を持たず、地図がそのことをデバッグログへ警告する）。
    act(() => setDebugEnabled(true));
    await user.click(screen.getByRole("button", { name: "メニュー" }));
    await user.click(screen.getByRole("button", { name: "使い方を見る" }));
    expect(screen.getByText("説明モード")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "やめる" }));
    expect(screen.queryByText("説明モード")).toBeNull();

    await user.click(screen.getByRole("button", { name: "メニュー" }));
    await user.click(screen.getByRole("button", { name: "デバッグログを表示" }));
    expect(screen.getByText(/^デバッグログ\[/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^デバッグログ\[.*を閉じる$/ }));
    expect(screen.queryByText(/^デバッグログ\[/)).toBeNull();
  });

  // 浮きパネルの中の部品に文が無いと、説明を見る状態で押しても「説明はまだありません」と名前しか出ず、使い方を読めない。
  it.each([
    ["PC", () => {}],
    ["スマホ", useMobileLayout],
  ])("%s の生成前の画面で、「中を見る」で開いた浮きパネルの中の部品はどれも使い方の文を出す", async (_, layout) => {
    layout();
    const { user } = renderHome();
    const enter = async () => {
      await user.click(screen.getByRole("button", { name: "メニュー" }));
      await user.click(screen.getByRole("button", { name: "使い方を見る" }));
    };
    await enter();
    const outsideGuide = (element: Element) => !isInUsageGuide(element);
    const openers = [...document.querySelectorAll(`[${USAGE_OPENS_ATTRIBUTE}]`)].filter(outsideGuide);
    // 部品の集め方が空振りすると、何も見ずに通る。
    expect(openers.length).toBeGreaterThan(3);

    const missing: string[] = [];
    let inside = 0;
    for (const opener of openers) {
      await user.click(opener);
      await user.click(screen.getByRole("button", { name: "中を見る" }));
      const opened = document.getElementById(opener.getAttribute("aria-controls") ?? "");
      expect(opened).not.toBeNull();
      const parts = [...opened!.querySelectorAll(USAGE_PART_SELECTOR)].filter(outsideGuide);
      inside += parts.length;
      // 部品を1つずつ押すと時間の上限を超えるので、説明の面が押された部品から文を引くのと同じ`usageTargetOf`で引く
      // （文が無いときの「説明はまだありません」は`components/UsageGuide/UsageGuide.test.tsx`が見る）。
      for (const part of parts) {
        if (!usageTargetOf(part)?.usage)
          missing.push(`${opener.getAttribute("aria-label") || opener.textContent} の中の ${part.textContent}`);
      }
      await user.click(screen.getByRole("button", { name: "やめる" }));
      await user.keyboard("{Escape}");
      await enter();
    }
    expect(inside).toBeGreaterThan(3);
    expect(missing).toEqual([]);
  });
});
