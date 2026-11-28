/**
 * `app/page.tsx`——トップページの走行モードのうち、次に曲がる所の案内。
 *
 * 見ること: 次に曲がる所がカードと地図の札に出ること、音声案内を入れると次に曲がる所を初めて知ったときと手前の段ごとに読み、
 * ルートを外れた・戻ったことを読むこと（読み上げを持たない端末ではボタンを出さないこと）、音声案内を入れている間に入れる黒の画面が
 * 次に曲がる所（外れている間は外れたこと、曲がる所が無ければ残り）と音声案内の入り切りだけを出し、その間も読み上げが続くこと。
 *
 * ここで見ないもの: 走っている間の配置・現在地の当て方・ルートを外れたことの帯は`app/page.ride.test.tsx`が見る。
 * 次に曲がる所の選び方・読み上げの段と言葉は`features/ride/`の各テストが見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、読み上げ（`speechSynthesis`）、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installGeolocation } from "@/testing/geolocation";
import { installSpeechSynthesis } from "@/testing/speechSynthesis";
import { makeRouteSegment } from "@/testing/routeFixtures";
import {
  HERE,
  LOOP_CONDITIONS,
  RIDDEN,
  RIDDEN_MIDDLE,
  candidateTabs,
  generate,
  marksAt,
  renderHome,
  serveHome,
} from "@/testing/homePage";
import { mapOnScreen } from "@/testing/maplibre";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

/** 要素の中に描いた矢印の線。 */
function arrowPaths(element: Element) {
  return [...element.querySelectorAll("path")].map((path) => path.getAttribute("d"));
}

/** 絵の線`path`の端の点（絵の単位。真ん中が交差点で、`y`は下が正）。 */
function endsOf(path: Element) {
  const points = [...path.getAttribute("d")!.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map(([, x, y]) => ({
    x: Number(x),
    y: Number(y),
  }));
  return { first: points[0], last: points.at(-1)! };
}

describe("走行モードの案内", () => {
  it("走行中は、現在地より先でいちばん近い曲がる所の絵と距離を地図の上のカードに出し、その地点にカードと同じ絵の札を出す。絵は交差点へ入る向きを上にし、その交差点のほかの道を薄く描く", async () => {
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    const turnPoint = { latitude: 35.7, longitude: 139.708 };
    jobs.respond(
      [
        {
          ...RIDDEN,
          turns: [{ distance_km: 0.8, direction: "right", other_road_bearings_deg: [0, 180], ...turnPoint }],
        },
      ],
      LOOP_CONDITIONS,
    );
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "走行モード" }));

    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    const card = screen.getByRole("status", { name: "300m先で右折" });
    // カードは距離だけを文字で出し、向きの言葉は読み上げの名前にだけ出す。
    expect(card).toHaveTextContent("300m");
    expect(card).not.toHaveTextContent("右折");
    const [placed] = marksAt(turnPoint);
    const mark = placed.element;
    expect(mark).toHaveAccessibleName("曲がる所: 右折");
    expect(arrowPaths(mark)).toEqual(arrowPaths(card));
    // 東へ進むルートなので、ルートの線は下から入って上へ抜け、北と南の道は左と右へ出る。
    const [route] = [...card.querySelectorAll("svg > path")].map(endsOf);
    expect(route.first.y).toBeGreaterThan(36);
    expect(route.last.y).toBeLessThan(14);
    const otherRoads = [...card.querySelectorAll("g[opacity] path")].map((path) => endsOf(path).last);
    expect(otherRoads).toEqual([
      { x: expect.closeTo(4, 0), y: expect.closeTo(24, 0) },
      { x: expect.closeTo(44, 0), y: expect.closeTo(24, 0) },
    ]);
    // 札の絵は入る向き（東）を上に描くので、北を上にした地図では東を上から右へ回し、札の中の道を真下の地図の道とそろえる。
    // 地図を回しても、回した分だけ戻して地図の道とそろったままにする。
    expect(placed.screenRotationDeg).toBeCloseTo(90, 0);
    act(() => mapOnScreen().rotateByHand(90));
    expect(marksAt(turnPoint)[0].screenRotationDeg).toBeCloseTo(0, 0);
    // 現在地の印（強調色の丸）と取り違えないよう、丸でも強調色でもない。
    expect(mark.style.borderRadius).not.toBe("50%");
    expect(mark.style.background).not.toContain("--color-accent");

    // 曲がる所を過ぎたら出さない。
    geolocation.deliver({ latitude: 35.7, longitude: 139.709, accuracy: 20 });
    expect(screen.queryByRole("status", { name: /先で右折$/ })).toBeNull();
    expect(marksAt(turnPoint)).toEqual([]);
  });

  it("音声案内を入れると、入れたことを読み、次に曲がる所を初めて知ったときと手前の段に入るたびに向きを日本語で1回ずつ読み、ルートを外れた・戻ったことを読む。案内を終えると読み上げを捨てて切に戻す", async () => {
    const geolocation = installGeolocation(HERE);
    const speech = installSpeechSynthesis();
    const { user } = renderHome();
    // 東へ2km進むルートで、経度0.001度が約0.1km。0.6kmで右折し、1.9kmで左折する。
    const along = (km: number) => ({ latitude: 35.7, longitude: 139.7 + km / 100, accuracy: 20 });
    const segment = makeRouteSegment({
      start_latitude: 35.7,
      start_longitude: 139.7,
      end_latitude: 35.7,
      end_longitude: 139.72,
      distance_km: 2,
      estimated_arrival_time: "2026-10-13T09:00:00+09:00",
    });
    const turns = [
      { distance_km: 0.6, direction: "right" as const, other_road_bearings_deg: [], ...along(0.6) },
      { distance_km: 1.9, direction: "left" as const, other_road_bearings_deg: [], ...along(1.9) },
    ];
    jobs.respond([{ ...RIDDEN, segments: [segment], distance_km: 2, turns }], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "走行モード" }));
    const voice = screen.getByRole("button", { name: "音声案内" });
    expect(voice).toHaveAttribute("aria-pressed", "false");

    // 切っている間は、曲がる所に近づいても、ルートを外れても読まない。
    geolocation.deliver(along(0));
    geolocation.deliver({ ...along(0), latitude: 35.702 });
    geolocation.deliver(along(0));
    expect(speech.texts()).toEqual([]);

    // 入れると、その操作の中で入れたことを読み、次に曲がる所を読む。
    await user.click(voice);
    expect(voice).toHaveAttribute("aria-pressed", "true");
    const heard = ["音声案内を入れました", "次は600メートル先、右折です"];
    expect(speech.texts()).toEqual(heard);
    // 手前の段に入るたびに1回ずつ読み、同じ段の中を進んでも読み直さない。
    geolocation.deliver(along(0.1));
    geolocation.deliver(along(0.15));
    geolocation.deliver(along(0.45));
    geolocation.deliver(along(0.56));
    heard.push("500メートル先、右折です", "150メートル先、右折です", "まもなく右折です");
    expect(speech.texts()).toEqual(heard);
    // 曲がり終えたら、次の曲がる所までを読む。
    geolocation.deliver(along(0.7));
    heard.push("次は1.2キロ先、左折です");
    expect(speech.texts()).toEqual(heard);
    // 外れた・戻ったことを読み、戻っても同じ曲がる所を読み直さない。
    geolocation.deliver({ ...along(0.8), latitude: 35.702 });
    geolocation.deliver(along(0.8));
    heard.push("ルートを外れました", "ルートに戻りました");
    expect(speech.texts()).toEqual(heard);
    expect(new Set(speech.langs())).toEqual(new Set(["ja-JP"]));
    expect(speech.volumes()).toEqual(heard.flatMap(() => [0, 1]));

    await user.click(screen.getByRole("button", { name: "走行モード" }));
    await user.click(screen.getByRole("button", { name: "案内を終える" }));
    expect(speech.cancels()).toBe(1);
    await user.click(screen.getByRole("button", { name: "走行モード" }));
    expect(screen.getByRole("button", { name: "音声案内" })).toHaveAttribute("aria-pressed", "false");
    vi.unstubAllGlobals();
  });

  it("音声案内を入れている間は黒の画面へ入れ、黒の画面は次に曲がる所の絵（カードと同じ）と距離と向き（外れている間は外れたこと、曲がる所が無ければ残り）と音声案内の入り切りだけを出し、その間も位置を受けて読み上げ、触れると地図に戻る", async () => {
    const geolocation = installGeolocation(HERE);
    const speech = installSpeechSynthesis();
    const { user } = renderHome();
    // 東へ2km進むルートで、経度0.001度が約0.1km。0.6kmで右折する。
    const along = (km: number) => ({ latitude: 35.7, longitude: 139.7 + km / 100, accuracy: 20 });
    const segment = makeRouteSegment({
      start_latitude: 35.7,
      start_longitude: 139.7,
      end_latitude: 35.7,
      end_longitude: 139.72,
      distance_km: 2,
      estimated_arrival_time: "2026-10-13T09:00:00+09:00",
    });
    const turns = [{ distance_km: 0.6, direction: "right" as const, other_road_bearings_deg: [0], ...along(0.6) }];
    jobs.respond([{ ...RIDDEN, segments: [segment], distance_km: 2, turns }], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "走行モード" }));
    geolocation.deliver(along(0));
    expect(screen.queryByRole("button", { name: "黒の画面" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "音声案内" }));
    await user.click(screen.getByRole("button", { name: "黒の画面" }));
    const dark = screen.getByRole("dialog", { name: "黒の画面" });
    expect(dark).toHaveTextContent("600m 右折");
    expect(arrowPaths(dark.querySelector("svg")!)).toEqual(
      arrowPaths(screen.getByRole("status", { name: "600m先で右折" })),
    );

    // 黒の画面の間も位置を受け、距離を出し直して手前の段で読む。
    geolocation.deliver(along(0.1));
    expect(dark).toHaveTextContent("500m 右折");
    expect(speech.texts().at(-1)).toBe("500メートル先、右折です");

    // 黒の画面のまま音声案内を切り・入れできる。
    const voice = within(dark).getByRole("button", { name: "音声案内" });
    await user.click(voice);
    expect(voice).toHaveAttribute("aria-pressed", "false");
    await user.click(voice);
    expect(voice).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("dialog", { name: "黒の画面" })).toBe(dark);

    // 外れている間は外れたことを、曲がる所を全部過ぎたら残りを出す。
    geolocation.deliver({ ...along(0.1), latitude: 35.702 });
    expect(dark).not.toHaveTextContent("右折");
    geolocation.deliver(along(0.8));
    expect(dark).toHaveTextContent("残り 1.2km");

    await user.click(within(dark).getByRole("button", { name: "地図に戻る" }));
    expect(screen.queryByRole("dialog", { name: "黒の画面" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "音声案内" }));
    vi.unstubAllGlobals();
  });

  it("読み上げを持たない端末では、走行中に音声案内のボタンを出さない", async () => {
    installGeolocation(HERE);
    const { user } = renderHome();
    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "走行モード" }));
    expect(screen.getByRole("button", { name: "ロック" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "音声案内" })).toBeNull();
  });
});
