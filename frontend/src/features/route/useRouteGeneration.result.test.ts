/**
 * ルート生成（`useRouteGeneration.ts`）の結果——候補は所要時間の短い順に並べて生成に使われた重みと一緒に渡し、押した1回の
 * 結果の種類（候補・候補0件・失敗）を知らせて、直近の結果（件数・0件の理由・失敗）を返す。backendが目的地を補正したら
 * 置いた目的地を動かし、上書きした重みを送れなかったときは既定の配分で作ったと返す。
 *
 * ここで見ないもの:
 * - 送る要求・入力の誤り・進み方・条件のずれ・消す → `useRouteGeneration.test.ts`
 * - 所要時間の並べ方の細部（時間の無い候補の位置） → `routeTabLabel.test.ts`
 * - 結果を一覧へ入れる・知らせを画面に出す → `useRouteResults.test.ts`・`app/page.test.tsx`
 *
 * 差し替えたもの: 生成のジョブと軸カタログの応答（網の層。`testing/routeGeneration.ts`）。条件は
 * 本物の`useGenerationConditions`を同じ描画で通して作る（呼び出し側と同じく、補正した目的地はそこへ書き戻る）。
 */
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { heldReplies } from "@/testing/backendServer";
import {
  A,
  B,
  placeDestination,
  renderGeneration,
  route,
  serveRouteGeneration,
  submit,
  used,
} from "@/testing/routeGeneration";
import type { Coordinates } from "@/types/route";

const NO_ROUTES_MESSAGE = "条件に合うルート候補が見つかりませんでした。条件を変えて試してください。";

let backend: ReturnType<typeof serveRouteGeneration>;

beforeEach(() => {
  window.localStorage.clear();
  backend = serveRouteGeneration();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("生成の結果", () => {
  it("候補を所要時間の短い順に並べ、生成に使われた重みと一緒に渡して新しい結果として知らせる。案内・目的地の補正は出さない", async () => {
    const rendered = renderGeneration();
    backend.respond([route("slow", 3600), route("fast", 1800)], used({ route_preference: { axis_a: 1 } }));

    await submit(rendered);

    expect(rendered.onGenerated).toHaveBeenCalledWith([route("fast", 1800), route("slow", 3600)], { axis_a: 1 });
    expect(rendered.onOutcome).toHaveBeenCalledWith("fresh");
    expect(rendered.result.current.generation.outcome).toBeNull();
    expect(rendered.result.current.generation.destinationCorrected).toBe(false);
  });

  it.each([{ label: "理由が届かなければ決まった文言", reason: undefined, message: NO_ROUTES_MESSAGE }])(
    "候補0件は、「$label」を案内に出して候補0件として知らせ、失敗とは扱わない",
    async ({ reason, message }) => {
      const rendered = renderGeneration();
      backend.respond([], used(), reason);

      await submit(rendered);

      expect(rendered.onGenerated).toHaveBeenCalledWith([], used().route_preference);
      expect(rendered.onOutcome).toHaveBeenCalledWith("empty");
      expect(rendered.result.current.generation.outcome).toEqual({ kind: "empty", message });
    },
  );

  it("生成が失敗したら文言を失敗として返して知らせ、結果は渡さない。次の生成で消す", async () => {
    const message = "ルート生成がタイムアウトしました";
    const rendered = renderGeneration();
    backend.jobs.fail(message);

    await submit(rendered);

    expect(rendered.result.current.generation.outcome).toEqual({ kind: "failed", message });
    expect(rendered.onOutcome).toHaveBeenCalledWith("failed");
    expect(rendered.onGenerated).not.toHaveBeenCalled();

    backend.jobs.keepRunning();
    act(() => {
      void rendered.result.current.generation.submit();
    });
    expect(rendered.result.current.generation.outcome).toBeNull();
  });

  it("backendが目的地を補正したら、置いた目的地を補正後の地点へ動かして知らせ、条件が変わったとは扱わない", async () => {
    const rendered = renderGeneration();
    placeDestination(rendered, A);
    backend.respond([route("r1")], used({ destination: A, corrected_destination: B }));

    await submit(rendered);

    const { conditions, generation } = rendered.result.current;
    expect(conditions.destination).toEqual(B);
    expect(generation.destinationCorrected).toBe(true);
    expect(generation.conditionsDirty).toBe(false);
    expect(generation.generatedInput?.destination).toEqual(B);
  });

  it("生成を待つ間に目的地を置き直したら、補正後の地点で置き直した目的地を上書きせず、条件が変わったと返す", async () => {
    const rendered = renderGeneration();
    placeDestination(rendered, A);
    const job = heldReplies();
    backend.jobs.answerWith(job.reply);
    let generating: Promise<void> = Promise.resolve();
    act(() => {
      generating = rendered.result.current.generation.submit();
    });

    const moved: Coordinates = { latitude: 35.72, longitude: 139.82 };
    act(() => rendered.result.current.conditions.setDestination(moved));
    await act(async () => {
      await job.answer(
        0,
        Response.json({
          status: "done",
          result: {
            routes: [route("r1")],
            conditions: used({ destination: A, corrected_destination: B }),
            no_candidates_reason: null,
          },
        }),
      );
      await generating;
    });

    const { conditions, generation } = rendered.result.current;
    expect(conditions.destination).toEqual(moved);
    expect(generation.generatedInput?.destination).toEqual(B);
    expect(generation.conditionsDirty).toBe(true);
  });

  it("上書きした重みは軸カタログが届いていれば送り、届かず送れなかったときだけ既定の配分で作ったと返す", async () => {
    const rendered = renderGeneration();
    backend.respond([route("r1")]);
    await submit(rendered);
    expect(rendered.result.current.generation.weightsNotApplied).toBe(false);

    act(() => rendered.result.current.conditions.setWeightOverrideEnabled(true));
    backend.respond([route("r1")]);
    await submit(rendered);
    expect(rendered.result.current.generation.weightsNotApplied).toBe(true);

    await backend.loadCatalog(rendered);
    backend.respond([route("r1")]);
    await submit(rendered);
    expect(backend.sentRequest()).toMatchObject({ route_preference: { axis_a: 0.4, axis_b: 0.6 } });
    expect(rendered.result.current.generation.weightsNotApplied).toBe(false);
  });
});
