/**
 * ルート生成（`useRouteGeneration.ts`）——押した「生成」を検証して、いまの条件からbackendへ要求を送り、実行中の進み方・
 * 入力の誤り・表示中の候補を作った条件といまの条件のずれを返し、案内と生成の結果を消せる。
 *
 * ここで見ないもの:
 * - 結果の並べ方と知らせ方・候補0件の理由・失敗の文言・目的地の補正・既定の配分で作ったこと → `useRouteGeneration.result.test.ts`
 * - 検証の文言の中身と、作るものが無いときの検証 → `RouteForm/useRouteFormSubmit.test.ts`
 * - 条件の値の持ち方（保存・地点の置き方・重みの揃え方） → `useGenerationConditions.test.ts`
 * - 入力から要求の形を組む細部（どの項目を比べないか・選んでいない出発時刻・キーの並びに依らない比較） →
 *   `generationRequest.test.ts`
 * - 要求の投げ方と見回り（ジョブの問い合わせ・打ち切り） → `routeApi.test.ts`
 * - 結果を一覧へ入れる・知らせを画面に出す → `useRouteResults.test.ts`・`app/page.test.tsx`
 *
 * 差し替えたもの: 生成のジョブと軸カタログの応答（網の層。`testing/routeGeneration.ts`）。条件は
 * 本物の`useGenerationConditions`を同じ描画で通して作る。
 */
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { heldReplies } from "@/testing/backendServer";
import {
  A,
  B,
  ORIGIN,
  PROPS,
  T1,
  placeDestination,
  renderGeneration,
  route,
  serveRouteGeneration,
  submit,
  used,
} from "@/testing/routeGeneration";

let backend: ReturnType<typeof serveRouteGeneration>;

beforeEach(() => {
  window.localStorage.clear();
  backend = serveRouteGeneration();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("送る要求", () => {
  it("全長の目標を決めていれば、いまの位置・入力した距離と候補数・走行条件・除外・選んだ道の避け方と、置いた経由地（置いた順）・目的地をそのまま送り、重みは送らない", async () => {
    const rendered = renderGeneration();
    const { conditions } = rendered.result.current;
    act(() => conditions.setDistanceInput("42"));
    act(() => rendered.result.current.conditions.setMaxRoutesInput("3"));
    placeDestination(rendered, A);
    act(() => rendered.result.current.conditions.selectPoint({ role: "waypoint", index: null }));
    act(() => rendered.result.current.conditions.placeAtSelected(B, null));
    act(() => rendered.result.current.conditions.placeAtSelected(A, null));
    // 選んでいない行はbackendが今の行へ揃えるので、選んだ段をそのまま送る。
    const avoidance = { gravel: "exclude", "retired.row": "avoid" } as const;
    act(() => rendered.result.current.conditions.setRoadAvoidance(avoidance));
    backend.respond([route("r1")]);

    await submit(rendered);

    expect(backend.sentRequest()).toEqual({
      latitude: ORIGIN.latitude,
      longitude: ORIGIN.longitude,
      distance_km: 42,
      road_avoidance: avoidance,
      max_routes: 3,
      assumed_speed_kmh: 20,
      start_time: T1.toISOString(),
      waypoints: [B, A],
      destination: A,
    });
  });

  it("全長の目標を外すと距離を送らず、置いた地点は同じに送る", async () => {
    const rendered = renderGeneration();
    act(() => rendered.result.current.conditions.setDistanceTargeted(false));
    placeDestination(rendered, A);
    backend.respond([route("r1")]);

    await submit(rendered);

    expect(backend.sentRequest()).not.toHaveProperty("distance_km");
    expect(backend.sentRequest()).toMatchObject({ destination: A });
  });
});

describe("入力の誤り", () => {
  it("入力の誤りは、直前の生成の失敗の文言より先に出す", async () => {
    const rendered = renderGeneration();
    backend.jobs.fail("リクエストに失敗しました");
    await submit(rendered);

    rendered.rerender({ ...PROPS, originKnown: false });
    await submit(rendered);

    expect(rendered.result.current.generation.outcome?.message).toMatch(/^現在地が分かりません/);
  });
});

describe("進み方", () => {
  it("実行中は進み方を文言で返し、順番待ちかを見分けられる。終わると実行中でなくなる", async () => {
    // 問い合わせの間隔と経過時間は時計で進める。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const rendered = renderGeneration();
    const job = heldReplies();
    backend.jobs.answerWith(job.reply);
    const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = rendered.result.current.generation.submit();
    });
    expect(rendered.result.current.generation.running).toBe(true);
    expect(rendered.result.current.generation.progressLabel).toBeUndefined();

    await job.answer(0, Response.json({ status: "queued" }));
    await flush();
    expect(rendered.result.current.generation.progressLabel).toBe("順番待ち...");

    await act(() => vi.advanceTimersByTimeAsync(2600));
    await job.answer(1, Response.json({ status: "running" }));
    await flush();
    expect(rendered.result.current.generation.progressLabel).toBe("生成中...(3秒経過)");

    await act(() => vi.advanceTimersByTimeAsync(1500));
    await job.answer(
      2,
      Response.json({
        status: "done",
        result: { routes: [route("r1")], conditions: used(), no_candidates_reason: null },
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await done;
    });
    expect(rendered.result.current.generation.running).toBe(false);
    expect(rendered.result.current.generation.progressLabel).toBeUndefined();
  });
});

describe("条件のずれ", () => {
  it("作った後に条件を変えると、候補がある間だけずれていると返し、作り直すと消える", async () => {
    const rendered = renderGeneration();
    expect(rendered.result.current.generation.conditionsDirty).toBe(false);
    backend.respond([route("r1")]);
    await submit(rendered);
    expect(rendered.result.current.generation.conditionsDirty).toBe(false);

    act(() => rendered.result.current.conditions.setDistanceInput("50"));
    expect(rendered.result.current.generation.conditionsDirty).toBe(true);

    rendered.rerender({ ...PROPS, hasRoutes: false });
    expect(rendered.result.current.generation.conditionsDirty).toBe(false);

    rendered.rerender(PROPS);
    backend.respond([route("r1")]);
    await submit(rendered);
    expect(rendered.result.current.generation.conditionsDirty).toBe(false);
  });
});

describe("消す", () => {
  it("案内を消す。実行中は何もしない", async () => {
    const rendered = renderGeneration();
    backend.jobs.fail("リクエストに失敗しました");
    await submit(rendered);

    act(() => rendered.result.current.generation.clearNotice());
    expect(rendered.result.current.generation.outcome).toBeNull();

    backend.jobs.keepRunning();
    act(() => {
      void rendered.result.current.generation.submit();
    });
    act(() => rendered.result.current.generation.clearNotice());
    expect(rendered.result.current.generation.running).toBe(true);
  });

  it("生成の結果（作った条件・補正・既定の配分・案内）を消す", async () => {
    const rendered = renderGeneration();
    act(() => rendered.result.current.conditions.setWeightOverrideEnabled(true));
    act(() => rendered.result.current.conditions.setDestination(A));
    backend.respond([route("r1")], used({ corrected_destination: B }));
    await submit(rendered);
    backend.jobs.fail("リクエストに失敗しました");
    await submit(rendered);

    act(() => rendered.result.current.generation.clear());

    const { generation } = rendered.result.current;
    expect(generation.generatedInput).toBeNull();
    expect(generation.destinationCorrected).toBe(false);
    expect(generation.weightsNotApplied).toBe(false);
    expect(generation.outcome).toBeNull();
  });
});
