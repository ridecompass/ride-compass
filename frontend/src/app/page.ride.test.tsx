/**
 * `app/page.tsx`——トップページの走行モードのうち、走っている間に見えるもの。
 *
 * 見ること: 走行モードの間の配置（上の帯を走りの数字に替え、パネルと「現在地に移動」を隠し、選んだ候補のプロファイルを
 * 見るだけで地図の下に出すこと・「表示」と「評価で塗る」は走っていないときと同じに出し、走行中に効かない操作は出さないこと・
 * 方位磁針で北が上と進む向きが上を切り替えること）と、届いた現在地がプロファイルの印と
 * 地図のルート線の薄めと走りの帯の残りへ同じ距離で渡り、到着予想が位置を受けた時刻と選んだ候補の計画から出ること、
 * 次に曲がる所がカードと地図の札に出ること、ルートを外れた・戻ったことが走りの帯に出ること、読み込み直しても走行モードが続くこと、
 * 読み込み直しで iPhone がスマホの向きを読む許しを聞けなかったら、ボタンの横から求め直して現在地の印に向きを出せること、
 * 走行中も左下に俯瞰図を出すこと。
 *
 * ここで見ないもの: 休む・帯の「ルート」で出したパネル・地図を押すこと・「このルートで走る」・スマホで走行中に下部タブを隠すこと（帯の「ルート」のシートを閉じた後に見る）は`app/page.rideControl.test.tsx`が見る。
 * 残りの距離・次に曲がる所の選び方・走りの帯の書式は`features/ride/`の各テストが見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、iPhone の向きを読む許しを求める口（`DeviceOrientationEvent.requestPermission`）と
 * 向きの出来事、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { FACT_DISPLAY_NAME } from "@/lib/screenNames";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MINUTE_MS } from "@/lib/duration";
import { formatJstHourMinute } from "@/lib/time";
import { onBackend } from "@/testing/backendServer";
import { installGeolocation } from "@/testing/geolocation";
import {
  FIRST,
  HERE,
  LOOP_CONDITIONS,
  RIDDEN,
  RIDDEN_MIDDLE,
  candidateTabs,
  clickMap,
  generate,
  linesOn,
  marksAt,
  renderHome,
  selectedPointMarks,
  selectedSectionOnMap,
  serveHome,
} from "@/testing/homePage";
import { mapOnScreen } from "@/testing/maplibre";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

/** 要素の中に描いた矢印の線。 */
function arrowPaths(element: HTMLElement) {
  return [...element.querySelectorAll("path")].map((path) => path.getAttribute("d"));
}

describe("走行モード", () => {
  it("走行モードの間は、上の帯を走りの数字に替え、パネルと「現在地に移動」を隠し、選んだ候補のプロファイルを地図の下に出す（結果の図と同じくなぞると地図に地点の印とその区間の縁取りと区間の小窓が出る）。止めると元に戻る", async () => {
    const { user } = renderHome();
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const rideProfile = () => screen.queryByRole("region", { name: "予定ルートのプロファイル" });
    const shownWhileIdle = () => [
      screen.queryByText(/^気温:/),
      screen.queryByRole("button", { name: "ルート設定" }),
      screen.queryByRole("button", { name: "現在地に移動" }),
    ];
    await screen.findByText(/^気温:/);
    expect(shownWhileIdle().every((element) => element !== null)).toBe(true);
    expect(rideProfile()).toBeNull();

    await user.click(screen.getByRole("button", { name: "走行モード" }));
    expect(screen.getByRole("group", { name: "走りの数字" })).toBeInTheDocument();
    expect(shownWhileIdle()).toEqual([null, null, null]);
    const chart = within(rideProfile()!).getByRole("slider", { name: /^道のりに沿った難易度/ });
    expect(selectedPointMarks()).toHaveLength(0);
    fireEvent.keyDown(chart, { key: "Home" });
    expect(selectedPointMarks()).toHaveLength(1);
    expect(selectedSectionOnMap()).toEqual(linesOn("route-segments"));
    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toBeInTheDocument();
    // 何も無い所を押すと、小窓を閉じて選びを外す（走行中も押した物の小窓の決まりは同じ）。
    clickMap(HERE);
    expect(selectedPointMarks()).toHaveLength(0);
    expect(selectedSectionOnMap()).toEqual([]);
    // グラフに出す情報は、ページが持つ1つの選択（はじめは標高）を走行中の図にも渡す。
    await user.click(within(rideProfile()!).getByRole("tab", { name: FACT_DISPLAY_NAME }));
    await user.click(within(rideProfile()!).getByRole("button", { name: "グラフに出す情報" }));
    expect(within(screen.getByRole("dialog")).getByRole("checkbox", { name: "標高" })).toBeChecked();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "走行モード" }));
    await user.click(screen.getByRole("button", { name: "案内を終える" }));
    expect(screen.queryByRole("group", { name: "走りの数字" })).toBeNull();
    expect(shownWhileIdle().every((element) => element !== null)).toBe(true);
    expect(rideProfile()).toBeNull();
  });

  it("走行中も「表示」と「評価で塗る」を出してピルから一覧を開け、出したまま現在地を追い、方位磁針で北が上と進む向きが上を切り替え、走行条件・「現在地に移動」は出さない", async () => {
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);

    await user.click(screen.getByRole("button", { name: "走行モード" }));
    geolocation.deliver(RIDDEN_MIDDLE);

    expect(screen.getByRole("button", { name: "地図に出す情報" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^評価で塗る: / }));
    expect(await screen.findByRole("radiogroup", { name: "評価で塗る" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "進む向きを上にする（いまは北が上）" }));
    expect(screen.getByRole("button", { name: "北を上にする（いまは進む向きが上）" })).toBeInTheDocument();
    expect([
      screen.queryByRole("group", { name: "走行条件" }),
      screen.queryByRole("button", { name: "現在地に移動" }),
    ]).toEqual([null, null]);
    geolocation.deliver(RIDDEN_MIDDLE);
    expect(screen.queryByRole("button", { name: "現在地へ戻る" })).toBeNull();
  });

  it("走行中も、気象の層を出して寄せていれば左下に俯瞰図を出す", async () => {
    onBackend("GET", "/api/weather/msm-grid", () =>
      Response.json({ times: [], latitude_step_deg: 0.05, longitude_step_deg: 0.0625, points: [] }),
    );
    installGeolocation(HERE);
    const { user } = renderHome();
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);
    await user.click(screen.getByRole("button", { name: "走行モード" }));

    await user.click(screen.getByRole("button", { name: "地図に出す情報" }));
    await user.click(screen.getByRole("checkbox", { name: "風[矢印]" }));
    await user.keyboard("{Escape}");
    act(() => mapOnScreen().moveTo({ west: 139.68, south: 35.69, east: 139.72, north: 35.71 }, 12));

    expect(await screen.findByRole("region", { name: "俯瞰図" })).toBeInTheDocument();
  });

  it("走行モードで届いた現在地を選んだ候補の上の距離へ当て、プロファイルに印を出し、地図のルート線のそこまでを薄め、走りの帯に残りと到着予想を出す", async () => {
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "走行モード" }));
    const fixedAt = Date.parse("2026-10-13T05:00:00Z");
    geolocation.deliver({ ...RIDDEN_MIDDLE, timestamp: fixedAt });

    // 残りの0.5kmは、計画では2分。計画の時刻（出発）ではなく、位置を受けた時刻から数える。
    const arrival = new Date(fixedAt + 2 * MINUTE_MS);
    const rideBar = screen.getByRole("group", { name: "走りの数字" });
    expect(rideBar).toHaveTextContent("残り: 0.5km");
    expect(rideBar).toHaveTextContent(`到着予想: ${formatJstHourMinute(arrival)}`);
    const profile = screen.getByRole("region", { name: "予定ルートのプロファイル" });
    expect(profile.querySelector('[data-progress="position"]')).not.toBeNull();
    const drawn = mapOnScreen().sourceFeatures("route-segments");
    expect(drawn.map((feature) => feature.properties?.travelled ?? false)).toEqual([true, false]);
  });

  it("走行中は、現在地より先でいちばん近い曲がる所の向きと距離を地図の上のカードに出し、その地点にカードと同じ矢印の札を出す", async () => {
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    const turnPoint = { latitude: 35.7, longitude: 139.708 };
    jobs.respond([{ ...RIDDEN, turns: [{ distance_km: 0.8, direction: "right", ...turnPoint }] }], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "走行モード" }));

    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    const card = screen.getByRole("status", { name: "300m先で右折" });
    const [mark] = marksAt(turnPoint).map((mark) => mark.element);
    expect(mark).toHaveAccessibleName("曲がる所: 右折");
    expect(arrowPaths(mark)).toEqual(arrowPaths(card));
    // 現在地の印（強調色の丸）と取り違えないよう、丸でも強調色でもない。
    expect(mark.style.borderRadius).not.toBe("50%");
    expect(mark.style.background).not.toContain("--color-accent");

    // 曲がる所を過ぎたら出さない。
    geolocation.deliver({ latitude: 35.7, longitude: 139.709, accuracy: 20 });
    expect(screen.queryByRole("status", { name: /先で右折$/ })).toBeNull();
    expect(marksAt(turnPoint)).toEqual([]);
  });

  it("走行中にルートを外れたら、走りの帯に外れたと出して残りを外れた点のまま止め、ルートへ戻ったら戻った点から続ける", async () => {
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "走行モード" }));
    const rideBar = screen.getByRole("group", { name: "走りの数字" });

    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    expect(rideBar).toHaveTextContent("残り: 0.5km");
    // 0.8km の所の北へ約220m（位置の誤差 20m を超えて）離れた。
    geolocation.deliver({ latitude: 35.702, longitude: 139.708, accuracy: 20 });
    expect(screen.getByRole("status", { name: "ルートを外れています" })).toBeInTheDocument();
    expect(screen.getByText(/ルートへ戻ると続きから案内します/)).toBeInTheDocument();
    expect(rideBar).toHaveTextContent("残り: 0.5km");
    // 回り道して、0.8km の所でルートへ戻った。
    geolocation.deliver({ latitude: 35.7, longitude: 139.708, accuracy: 20 });
    expect(screen.queryByRole("status", { name: "ルートを外れています" })).toBeNull();
    expect(screen.queryByText(/ルートへ戻ると続きから案内します/)).toBeNull();
    expect(rideBar).toHaveTextContent("残り: 0.2km");
  });

  it("走行中に画面を読み込み直しても、同じ候補を出して走行モードを続け、到着予想はその候補の計画から出す", async () => {
    const geolocation = installGeolocation(HERE);
    const first = renderHome();
    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(first.user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await first.user.click(screen.getByRole("button", { name: "走行モード" }));
    first.unmount();

    renderHome();
    const rideBar = await screen.findByRole("group", { name: "走りの数字" });
    expect(screen.getByRole("region", { name: "予定ルートのプロファイル" })).toBeInTheDocument();
    const fixedAt = Date.parse("2026-10-13T05:00:00Z");
    geolocation.deliver({ ...RIDDEN_MIDDLE, timestamp: fixedAt });
    const arrival = new Date(fixedAt + 2 * MINUTE_MS);
    expect(rideBar).toHaveTextContent(`到着予想: ${formatJstHourMinute(arrival)}`);
  });

  it("iPhone で読み込み直して向きを読む許しを聞けなかったら、ボタンの横に許しが要ることを出し、「向きを出す」で許すと現在地の印に向きを出して札を消す", async () => {
    const geolocation = installGeolocation(HERE);
    const first = renderHome();
    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(first.user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await first.user.click(screen.getByRole("button", { name: "走行モード" }));
    first.unmount();

    // iPhone の Safari は、まだ聞いていない許しを操作の外で求められると断り、利用者が許したあとは許しを返す。
    let answer: "granted" | null = null;
    const holder = globalThis as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } };
    holder.DeviceOrientationEvent = {
      requestPermission: async () => {
        if (answer === null)
          throw new DOMException(
            "Requesting device orientation access requires a user gesture to prompt",
            "NotAllowedError",
          );
        return answer;
      },
    };
    const facingCone = () => document.querySelector("[data-facing-cone]");
    const turnPhone = () =>
      act(() => {
        const event = new Event("deviceorientation");
        Object.assign(event, { webkitCompassHeading: 90, alpha: 0 });
        window.dispatchEvent(event);
      });
    try {
      const { user } = renderHome();
      const HEADING_NOTICE = /向きを読む許しが要ります/;
      await screen.findByText(HEADING_NOTICE);
      geolocation.deliver(RIDDEN_MIDDLE);
      turnPhone();
      expect(facingCone()).toHaveAttribute("visibility", "hidden");

      answer = "granted";
      await user.click(screen.getByRole("button", { name: "向きを出す" }));
      await waitFor(() => expect(screen.queryByText(HEADING_NOTICE)).toBeNull());
      turnPhone();
      expect(facingCone()).toHaveAttribute("visibility", "visible");
    } finally {
      holder.DeviceOrientationEvent = undefined;
    }
  });
});
