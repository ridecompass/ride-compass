/**
 * `app/page.tsx`——トップページの画面の枠（地図の上の操作・スマホのシート・ヘッダー・メニュー）。
 *
 * 見ること: 地図の表示をまとめて戻す操作（「表示」の一覧の末尾と右上のメニュー）、右上の方位磁針（地図の北を指し、
 * 開いたダイヤルで地図を回して北へ戻す）と拡大・縮小、スマホの下部タブとシート（1枚ずつ開く・地点を扱える間・結果の合図・
 * 候補が届いた時点で「ルート設定」を開いていれば「ルート結果」へ移ってそこから全消去でき、ほかのときは移らず合図を出すこと・
 * 候補を出せなかった理由の1行・決めた高さを2枚のシートで分け合うこと）、区分の開閉の保存、ヘッダーの「未取得」に並ぶ
 * 出所と「現在地に移動」の失敗、「現在地に移動」が出発地を変えずに地図を寄せて現在地に点を出すこと、メニューから入る
 * 使い方の説明とデバッグログ。
 *
 * ここで見ないもの: シートの高さの決め方・覚え方は`components/BottomSheet/BottomSheet.test.tsx`、ルートを収めるときに
 * シートを避けることは実寸が要るので`e2e/mobile.spec.ts`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setDebugEnabled } from "@/lib/debugLog";
import { heldReplies, onBackend } from "@/testing/backendServer";
import { installGeolocation } from "@/testing/geolocation";
import {
  ELSEWHERE,
  FIRST,
  HERE,
  LOOP_CONDITIONS,
  clickMap,
  confirmClear,
  generate,
  marksAt,
  renderHome,
  routeLinesOnMap,
  section,
  serveHome,
  showRoadSurface,
  useMobileLayout,
} from "@/testing/homePage";
import { mapOnScreen } from "@/testing/maplibre";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
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

  it("スマホでは下部タブでシートを1枚ずつ開き、地図で地点を扱えるのは「ルート設定」の条件タブを開いている間だけ。結果の合図は「ルート結果」を開くまで残り、押した結果が候補を出せなかった理由（候補0件の理由・入力の誤り）はシートでなく窓で出し、閉じると消える。候補0件の合図は成功と見分ける", async () => {
    installGeolocation(null);
    useMobileLayout();
    const { user } = renderHome();
    const settingsTab = () => screen.getByRole("button", { name: "ルート設定", expanded: false });
    const outcomeTab = screen.getByRole("button", { name: "ルート結果" });
    // 現在地が取れないので、地図の印は出発地の1つだけ。
    const originMark = () => mapOnScreen().markers()[0];
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(originMark().draggable).toBe(false);

    await user.click(settingsTab());
    const settingsSheet = screen.getByRole("dialog", { name: "ルート設定" });
    await user.click(within(settingsSheet).getByRole("button", { name: "ルート生成" }));
    const notice = screen.getByRole("dialog", { name: "ルートを作れませんでした" });
    expect(notice).toHaveAccessibleDescription(/^現在地が分かりません/);
    expect(within(settingsSheet).queryByText(/^現在地が分かりません/)).toBeNull();
    expect(outcomeTab).toHaveAccessibleDescription("生成に失敗しました");
    await user.click(within(notice).getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("dialog", { name: "ルートを作れませんでした" })).toBeNull();

    expect(originMark().draggable).toBe(true);
    await user.click(within(settingsSheet).getByRole("tab", { name: "重み" }));
    expect(originMark().draggable).toBe(false);
    await user.click(within(settingsSheet).getByRole("tab", { name: "条件" }));
    clickMap(HERE);
    jobs.respond([FIRST], LOOP_CONDITIONS);
    expect(await generate(user)).toMatchObject({ latitude: HERE.latitude, longitude: HERE.longitude });
    const outcomeSheet = await screen.findByRole("dialog", { name: "ルート結果" });
    await user.click(within(outcomeSheet).getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(settingsTab());
    act(() => screen.getByRole("slider", { name: "全長の目標" }).focus());
    await user.keyboard("{ArrowRight}");
    expect(outcomeTab).toHaveAccessibleDescription("生成条件が変更されています");
    jobs.respond([], LOOP_CONDITIONS, "起点の近くに道路データがありません");
    await generate(user);
    await waitFor(() => expect(outcomeTab).toHaveAccessibleDescription("候補が見つかりませんでした"));
    const empty = screen.getByRole("dialog", { name: "候補が見つかりませんでした" });
    expect(empty).toHaveAccessibleDescription("起点の近くに道路データがありません");
    await user.click(within(empty).getByRole("button", { name: "閉じる" }));
    await user.click(screen.getByRole("button", { name: "ルート設定", expanded: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("スマホで「ルート設定」から作って候補が出たら「ルート結果」のシートへ移り（開いたので結果の合図は点かない）、そこから候補を全消去できる", async () => {
    useMobileLayout();
    const { user } = renderHome();
    const outcomeTab = screen.getByRole("button", { name: "ルート結果" });
    await user.click(screen.getByRole("button", { name: "ルート設定" }));
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);

    const outcomeSheet = await screen.findByRole("dialog", { name: "ルート結果" });
    expect(screen.queryByRole("dialog", { name: "ルート設定" })).toBeNull();
    expect(outcomeTab).not.toHaveAccessibleDescription();
    await user.click(within(outcomeSheet).getByRole("button", { name: "候補を全消去" }));
    await confirmClear(user);
    expect(within(outcomeSheet).queryByRole("tablist", { name: "ルート結果" })).toBeNull();
    expect(routeLinesOnMap()).toEqual([]);
  });

  it.each([
    { leave: "シートを閉じる", outcomeSheetOpen: false },
    { leave: "「ルート結果」へ切り替える", outcomeSheetOpen: true },
  ])(
    "スマホで「ルート設定」から作ったあと、待つ間に（$leave）候補が出てもシートは移らず「ルート結果」のタブに合図が出る",
    async ({ outcomeSheetOpen }) => {
      useMobileLayout();
      const { user } = renderHome();
      const outcomeTab = screen.getByRole("button", { name: "ルート結果" });
      await user.click(screen.getByRole("button", { name: "ルート設定" }));
      const job = heldReplies();
      jobs.answerWith(job.reply);
      await generate(user);
      const settingsSheet = screen.getByRole("dialog", { name: "ルート設定" });
      await user.click(outcomeSheetOpen ? outcomeTab : within(settingsSheet).getByRole("button", { name: "閉じる" }));

      await job.answer(0, Response.json({ status: "done", result: { routes: [FIRST], conditions: LOOP_CONDITIONS } }));
      await waitFor(() => expect(outcomeTab).toHaveAccessibleDescription("新しい結果があります"));
      expect(screen.queryByRole("dialog", { name: "ルート設定" })).toBeNull();
      expect(screen.queryByRole("dialog", { name: "ルート結果" }) !== null).toBe(outcomeSheetOpen);
    },
  );

  it("スマホのシートの高さは、確定した値を2枚のシートで共有し、次に開いたときも使う", async () => {
    useMobileLayout();
    const { user, unmount } = renderHome();
    await user.click(screen.getByRole("button", { name: "ルート設定" }));
    const handle = screen.getByRole("separator", { name: "パネルの高さを変更" });
    handle.focus();
    await user.keyboard("{ArrowUp}");
    expect(handle).toHaveAttribute("aria-valuenow", "55");
    unmount();

    renderHome();
    await user.click(screen.getByRole("button", { name: "ルート結果" }));
    expect(screen.getByRole("separator", { name: "パネルの高さを変更" })).toHaveAttribute("aria-valuenow", "55");
  });

  it("区分の開閉は、次に開いたときも同じになる", async () => {
    const { user, unmount } = renderHome();
    await user.click(section("ルート設定"));
    unmount();

    renderHome();
    expect(section("ルート設定")).toHaveAttribute("aria-expanded", "false");
    expect(section("ルート結果")).toHaveAttribute("aria-expanded", "true");
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

    clickMap(HERE);
    await waitFor(() => expect(missing()).toHaveAccessibleName(/警報/));
    expect(missing()).not.toHaveAccessibleName(/現在地/);
  });

  it("「現在地に移動」は現在地を取り直して地図を寄せ、出発地は変えずに現在地に点を出す", async () => {
    const { user } = renderHome();
    clickMap(ELSEWHERE);
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
});
