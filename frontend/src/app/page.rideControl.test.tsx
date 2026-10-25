/**
 * `app/page.tsx`——トップページの走行モードのうち、走っている間の操作。
 *
 * 見ること: スマホで走行中は下部タブを隠すこと・休んでいる間は位置を受けずにルートと進み具合を残し、「続きから走る」で続けること・地図を指で動かした間だけ
 * 「現在地へ戻る」を出すこと、走行中に帯の「ルート」で開いたパネルで選び直す・作り直すと走行モードが新しい候補を追い（地図をその候補へ収め直さない）、
 * パネルを出していない間は地図で何も変えも開きもしないこと、「このルートで走る」でその候補で走り始めてシートを閉じ、
 * 止めると走る前のシートへ戻ること。鍵のボタンでロックすると追い直して地図の手ぶりと押しを受けず、2か所を順に押すと外れること。パネルの中で区間を選んでも追い続けて地図を動かさず、「区間を地図で見る」で追うのを休んでその区間へ寄せ、選びを外すと追い直すこと。
 *
 * ここで見ないもの: 走っている間に見えるもの（帯・プロファイル・進み具合・次に曲がる所）は`app/page.ride.test.tsx`が見る。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得、地図の描画（`maplibre-gl`）。子の部品は本物を描く。
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installGeolocation } from "@/testing/geolocation";
import {
  ELSEWHERE,
  FIRST,
  HERE,
  LOOP_CONDITIONS,
  RIDDEN,
  RIDDEN_MIDDLE,
  SECOND,
  candidateTabs,
  clickMap,
  clickSegment,
  generate,
  linesOn,
  marksAt,
  renderHome,
  route,
  serveHome,
  useMobileLayout,
} from "@/testing/homePage";
import { UNLOCK_CHOICE_MS } from "@/features/ride/RideLockButton/RideLockButton";
import { mapOnScreen } from "@/testing/maplibre";
import { makeRouteSegment } from "@/testing/routeFixtures";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

describe("走行モードの操作", () => {
  it("走行モードのボタンで休むと、位置を受けるのをやめてルートと進み具合を残し、読み込み直しても休んだまま戻り、地図の下の「続きから走る」で休む前の進み具合から続ける。地図を指で動かすと「現在地へ戻る」を出し、ボタンで案内を終えると止める", async () => {
    const geolocation = installGeolocation(HERE);
    const first = renderHome();
    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(first.user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const backToHere = () => screen.queryByRole("button", { name: "現在地へ戻る" });
    const moveMapByHand = () =>
      act(() => mapOnScreen().emit("movestart", { originalEvent: new MouseEvent("mousedown") }));
    const rideButton = () => screen.getByRole("button", { name: "走行モード" });
    await first.user.click(rideButton());
    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    expect(screen.getByRole("group", { name: "走りの数字" })).toHaveTextContent("残り: 0.5km");
    expect(backToHere()).toBeNull();

    // ボタンを押すと選ぶ所を出し、休むを選ぶと位置を受けるのをやめ、走行モードのまま（ルートと進み具合を残して）休む。
    // 休む長さは分からないので、到着予想は出さない。
    await first.user.click(rideButton());
    await first.user.click(screen.getByRole("button", { name: "休む" }));
    expect(rideButton()).toHaveAttribute("data-ride", "resting");
    expect(geolocation.watching()).toBe(0);
    expect(screen.getByRole("group", { name: "走りの数字" })).toHaveTextContent("残り: 0.5km");
    expect(screen.getByRole("group", { name: "走りの数字" })).toHaveTextContent("到着予想: —");
    first.unmount();

    // 読み込み直しても、休んだまま戻る。
    const { user } = renderHome();
    const rideBar = await screen.findByRole("group", { name: "走りの数字" });
    expect(rideButton()).toHaveAttribute("data-ride", "resting");
    expect(geolocation.watching()).toBe(0);
    expect(rideBar).toHaveTextContent("残り: 0.5km");

    // 続きから走ると位置を受け直し、休む前の進み具合から続ける。
    await user.click(screen.getByRole("button", { name: "続きから走る" }));
    expect(geolocation.watching()).toBe(1);
    geolocation.deliver({ latitude: 35.7, longitude: 139.708, accuracy: 20 });
    expect(rideButton()).toHaveAttribute("data-ride", "following");
    expect(rideBar).toHaveTextContent("残り: 0.2km");
    expect(screen.queryByRole("button", { name: "続きから走る" })).toBeNull();

    moveMapByHand();
    await user.click(backToHere()!);
    expect(backToHere()).toBeNull();
    expect(rideButton()).toHaveAttribute("data-ride", "following");

    await user.click(rideButton());
    await user.click(screen.getByRole("button", { name: "案内を終える" }));
    expect(screen.queryByRole("group", { name: "走りの数字" })).toBeNull();
    expect(geolocation.watching()).toBe(0);
  });

  it("走行モードのまま帯の「ルート」で左のパネルを出し、候補を選び直す・作り直すと、走行モードはその候補を追い続け、地図をその候補へ収め直さない", async () => {
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    // 東へ2km進む区間1つのルート。現在地（東経139.705度）はその4分の1の所。
    const longer = route("longer", {
      segments: [
        makeRouteSegment({
          start_latitude: 35.7,
          start_longitude: 139.7,
          end_latitude: 35.7,
          end_longitude: 139.72,
          distance_km: 2,
        }),
      ],
      distance_km: 2,
      // 選び直したときに収める範囲を持つよう、線の形も持たせる。
      geometry: {
        type: "LineString",
        coordinates: [
          [139.7, 35.7],
          [139.72, 35.7],
        ],
      },
    });
    jobs.respond([RIDDEN, longer], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "走行モード" }));
    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    const rideBar = screen.getByRole("group", { name: "走りの数字" });
    expect(rideBar).toHaveTextContent("残り: 0.5km");
    expect(screen.queryByRole("button", { name: "ルート結果" })).toBeNull();

    const routePanel = screen.getByRole("button", { name: "ルート" });
    await user.click(routePanel);
    expect(routePanel).toHaveAttribute("aria-expanded", "true");
    // 追っている間は追う側が地図を動かすので、選び直しても作り直しても収め直さない。
    const fitted = mapOnScreen().fits().length;
    await user.click(candidateTabs()[1]);
    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    expect(rideBar).toHaveTextContent("残り: 1.5km");

    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    expect(screen.getByRole("group", { name: "走りの数字" })).toHaveTextContent("残り: 0.5km");
    expect(mapOnScreen().fits()).toHaveLength(fitted);

    await user.click(routePanel);
    expect(screen.queryByRole("button", { name: "ルート結果" })).toBeNull();
  });

  it("スマホでは、走行中に帯の「ルート」で「ルート結果」のシートを開き、下部タブで「ルート設定」へ移れ、閉じると地図だけに戻る", async () => {
    useMobileLayout();
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: "走行モード" }));
    const routePanel = screen.getByRole("button", { name: "ルート" });

    await user.click(routePanel);
    expect(screen.getByRole("dialog", { name: "ルート結果" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ルート設定" }));
    expect(screen.getByRole("dialog", { name: "ルート設定" })).toBeInTheDocument();

    await user.click(routePanel);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "パネル切り替え" })).toBeNull();
    expect(screen.getByRole("group", { name: "走りの数字" })).toBeInTheDocument();
  });

  it("走行中に鍵のボタンでロックすると、地図を指で動かして休んでいれば追い直し、地図の手ぶりの操作を止め、地図や区間の印を押しても何も開かず閉じない。鍵を押して横に出る「ロックを外す」を押すと外れ、選ばずにいると時間で閉じ、案内を終えるとロックも外れる", async () => {
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
    // 開いていた小窓は、区間の印を押しても地図の外れを押しても閉じず、ほかの物を押しても開かない。
    const segmentMark = mapOnScreen()
      .markers()
      .find((mark) => mark.element.getAttribute("aria-label") === "選択中の区間")!;
    act(() => segmentMark.element.click());
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

  it("走行中も、地図を押しても地点を置かず、押した物は走っていない間と同じに扱い（線を押すとそのルートを選び、区間を押すと小窓を出す）、ピンは押せる物に数えない", async () => {
    const { user } = renderHome();
    jobs.respond([FIRST, SECOND], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(2));
    const [secondLine] = mapOnScreen()
      .sourceFeatures("route-candidates")
      .filter((line) => line.properties?.routeId === SECOND.id);
    const clickSecondLine = () =>
      clickMap(ELSEWHERE, [
        {
          layer: "route-candidates-candidateHit",
          properties: secondLine.properties ?? {},
          geometry: secondLine.geometry,
        },
      ]);
    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");
    await user.click(screen.getByRole("button", { name: "走行モード" }));

    clickMap(ELSEWHERE);
    expect(marksAt(ELSEWHERE)).toEqual([]);
    clickSegment(drawnSegment, HERE);
    expect(screen.getByRole("group", { name: "区間の小窓の上の帯" })).toBeInTheDocument();
    const [originPin] = marksAt(HERE);
    expect(originPin.draggable).toBe(false);
    expect(originPin.element.style.cursor).toBe("default");
    clickSecondLine();
    expect(linesOn("route-selected")).toEqual([SECOND.geometry.coordinates]);
  });

  it("走行中に帯の「ルート」で開いたパネルの中で区間を選んでも追い続け、「区間を地図で見る」を押すと追うのを休んでその区間へ寄せ、選びを外すと追い直す", async () => {
    const geolocation = installGeolocation(HERE);
    const { user } = renderHome();
    jobs.respond([RIDDEN], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    const rideButton = () => screen.getByRole("button", { name: "走行モード" });
    await user.click(rideButton());
    geolocation.deliver({ ...RIDDEN_MIDDLE, accuracy: 20 });
    expect(rideButton()).toHaveAttribute("data-ride", "following");
    await user.click(screen.getByRole("button", { name: "ルート" }));

    const [drawnSegment] = mapOnScreen().sourceFeatures("route-segments");
    const fitsBefore = mapOnScreen().fits().length;
    clickSegment(drawnSegment, HERE);
    expect(rideButton()).toHaveAttribute("data-ride", "following");
    expect(mapOnScreen().fits()).toHaveLength(fitsBefore);

    await user.click(screen.getAllByRole("button", { name: "区間を地図で見る" })[0]);
    expect(rideButton()).toHaveAttribute("data-ride", "paused");
    expect(mapOnScreen().fits().at(-1)?.bounds).toEqual([
      [139.7, 35.7],
      [139.71, 35.7],
    ]);

    // 何も無い所を押して選びを外すと、追い直す。
    clickMap(ELSEWHERE);
    expect(rideButton()).toHaveAttribute("data-ride", "following");
  });

  it("「このルートで走る」を押すと、その候補を選んで走行モードを始め、スマホはシートを閉じる。止めると走る前のシートへ戻る", async () => {
    useMobileLayout();
    const { user } = renderHome();
    jobs.respond([FIRST, SECOND], LOOP_CONDITIONS);
    await user.click(screen.getByRole("button", { name: "ルート設定" }));
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(2));
    await user.click(candidateTabs()[1]);

    await user.click(screen.getByRole("button", { name: "このルートで走る" }));
    expect(screen.getByRole("group", { name: "走りの数字" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(linesOn("route-selected")).toEqual([SECOND.geometry.coordinates]);

    await user.click(screen.getByRole("button", { name: "走行モード" }));
    await user.click(screen.getByRole("button", { name: "案内を終える" }));
    expect(screen.getByRole("dialog", { name: "ルート結果" })).toBeInTheDocument();
  });
});
