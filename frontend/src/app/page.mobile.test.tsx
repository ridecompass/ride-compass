/**
 * `app/page.tsx`——トップページのスマホの下部タブとシート。
 *
 * 見ること: シートを1枚ずつ開くこと・地点を扱える間・結果の合図・候補が届いた時点で「ルート設定」を開いていれば
 * 「ルート結果」へ移り、ほかのときは移らず合図を出すこと・候補を出せなかった理由の1行・
 * 決めた高さを2枚のシートで分け合うこと・シートを開いている間は地図の左下の俯瞰図を出さないこと。
 *
 * ここで見ないもの: シートの高さの決め方・覚え方は`components/BottomSheet/BottomSheet.resize.test.tsx`と
 * `components/BottomSheet/BottomSheet.fit.test.tsx`、ルートを収めるときにシートを避けることは実寸が要るので`e2e/mobile-route-result.spec.ts`が見る。走行中のスマホのシートは`app/page.rideControl.test.tsx`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { heldReplies, onBackend } from "@/testing/backendServer";
import { installGeolocation } from "@/testing/geolocation";
import {
  ELSEWHERE,
  FIRST,
  HERE,
  LOOP_CONDITIONS,
  clickMap,
  generate,
  marksAt,
  renderHome,
  serveHome,
  useMobileLayout,
} from "@/testing/homePage";
import { mapOnScreen } from "@/testing/maplibre";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

describe("スマホのシート", () => {
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
    expect(outcomeTab).not.toHaveAccessibleDescription();
    clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toEqual([]);
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

  it("スマホでシートを開いている間は、地図の左下の俯瞰図を出さず、閉じると戻す", async () => {
    onBackend("GET", "/api/weather/msm-grid", () =>
      Response.json({ times: [], latitude_step_deg: 0.05, longitude_step_deg: 0.0625, points: [] }),
    );
    useMobileLayout();
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("checkbox", { name: "風[矢印]" }));
    await user.keyboard("{Escape}");
    act(() => mapOnScreen().moveTo({ west: 139.68, south: 35.69, east: 139.72, north: 35.71 }, 12));
    expect(await screen.findByRole("region", { name: "俯瞰図" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "ルート設定" }));
    expect(screen.queryByRole("region", { name: "俯瞰図" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "ルート設定" }));
    expect(await screen.findByRole("region", { name: "俯瞰図" })).toBeInTheDocument();
  });
});
