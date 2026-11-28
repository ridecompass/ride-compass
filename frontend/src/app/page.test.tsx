/**
 * `app/page.tsx`——トップページ。機能（地図・ルートの設定と結果・走行条件・天候）を1つの画面に束ね、機能の間の値を受け渡す。
 * ページの結合テストは場面ごとに`app/page.<場面>.test.tsx`へ分け、ここはルートを作る流れのうち、ある機能の変化が
 * 別の機能の振る舞いを変える受け渡しを見る。
 *
 * ここで見ないもの: 子の部品は本物を描き、子が値をどう描くか（一覧の書式・印の色・天候の値）は各部品のテストが見る。
 * 地図の見え方の中身（どのレイヤーをどの色・重なりで描くか・レンズの選択肢・凡例）は地図の側（`features/map/scene/`）の
 * テストが見て、ここでは地図に何が載ったか（線のソースの地物・レイヤーの表示・印）と、地図の操作で何が起きるかだけを見る。
 * 機能の状態の移り変わり（生成の検証と要求の形・候補の並び・地点の置き方・レイヤーと凡例の状態）は各フックのテストが
 * 見る。子へ渡す受け口へフックの関数や値をそのまま渡す所（除外の入力・経由地を地図で動かす・消す・「現在地に戻す」・
 * 保存した条件を呼び出して現在地へ戻す・実行中の「ルート生成」・取り直している間の「現在地に移動」・まとめてレイヤーを消す
 * 操作を押せるか）は1行の委譲なので見ない。
 *
 * 差し替えたもの: backend の応答（網の層）、位置情報の取得（`navigator.geolocation`）、地図の描画（`maplibre-gl`）。
 * どれもテスト環境に無いものか、その手前の境界。地図は `@/testing/maplibre` の代役が受けたものを記録し、地図の操作
 * （押す・押した所に描かれている地物）はテストが代役から起こす。
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { heldReplies, onBackend, serveClientConfig, serveCostAxisCatalog } from "@/testing/backendServer";
import { AVOIDANCE_LEVELS, avoidanceRow, clientConfigResponse, roadClassCatalog } from "@/testing/clientConfig";
import { ROAD_AVOIDANCE_ROLE, ROAD_LINE_SOURCE_ID } from "@/features/map/scene/groups/roadLines";
import { sceneLayerId } from "@/features/map/scene/sceneBuilders";
import { ROAD_SETTINGS_TAB_NAME } from "@/lib/screenNames";
import {
  FIRST,
  HERE,
  LOOP_CONDITIONS,
  SECOND,
  candidateTabs,
  clickMap,
  confirmClear,
  generate,
  linesOn,
  renderHome,
  routeLinesOnMap,
  section,
  serveHome,
  serveRoadsAt,
  rightClickMap,
} from "@/testing/homePage";
import { mapOnScreen } from "@/testing/maplibre";
import { costAxisCatalog, costAxisEntry } from "@/testing/costAxes";
import type { Coordinates } from "@/types/route";
import { inspectorResult } from "@/testing/roadInspector";

vi.mock("maplibre-gl", () => import("@/testing/maplibre"));

let jobs: ReturnType<typeof serveHome>;

beforeEach(() => {
  jobs = serveHome();
});

/** 全部の道路をそのレンズで塗っているか。 */
function paints(lensId: string): boolean {
  return mapOnScreen().visibleLayerIds().includes(`road-tiles-${lensId}`);
}

describe("ルートを作る", () => {
  it("生成の結果が出たら閉じていた「ルート結果」を開く。候補は一覧と地図に出て、選んだ候補が区間を持つかで周りの塗りが決まる。全消去で両方から消える", async () => {
    const { user } = renderHome();
    await user.click(section("ルート結果"));
    expect(section("ルート結果")).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: /^走りにくさを色で見る/ }));
    await user.click(await screen.findByRole("radio", { name: /登坂/ }));
    await user.keyboard("{Escape}");
    expect(paints("ascent")).toBe(true);

    const job = heldReplies();
    jobs.answerWith(job.reply);
    await generate(user);
    expect(screen.getByRole("button", { name: /^生成中\.\.\.\(\d+秒経過\)$/ })).toBeInTheDocument();

    await job.answer(
      0,
      Response.json({ status: "done", result: { routes: [FIRST, SECOND], conditions: LOOP_CONDITIONS } }),
    );
    await waitFor(() => expect(section("ルート結果")).toHaveAttribute("aria-expanded", "true"));
    expect(candidateTabs()).toHaveLength(2);
    expect(routeLinesOnMap()).toHaveLength(2);
    expect(routeLinesOnMap()).toEqual(
      expect.arrayContaining([FIRST.geometry.coordinates, SECOND.geometry.coordinates]),
    );
    expect(linesOn("route-selected")).toEqual([FIRST.geometry.coordinates]);
    expect(paints("ascent")).toBe(false);

    await user.click(candidateTabs()[1]);
    expect(linesOn("route-selected")).toEqual([SECOND.geometry.coordinates]);
    expect(paints("ascent")).toBe(true);

    await user.click(screen.getByRole("button", { name: "候補を全消去" }));
    expect(routeLinesOnMap()).toHaveLength(2);
    await confirmClear(user);
    expect(screen.queryByRole("tablist", { name: "ルート結果" })).toBeNull();
    expect(routeLinesOnMap()).toEqual([]);
    expect(screen.queryByRole("button", { name: "候補を全消去" })).toBeNull();
  });

  it("条件を変えたことは、候補がある間だけ「ルート生成」の名前に足され、全消去で消える", async () => {
    const { user } = renderHome();
    const dirtyGenerate = () => screen.queryByRole("button", { name: "ルート生成（生成条件が変更されています）" });
    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);
    await waitFor(() => expect(candidateTabs()).toHaveLength(1));
    expect(dirtyGenerate()).toBeNull();

    act(() => screen.getByRole("slider", { name: "距離の目標" }).focus());
    await user.keyboard("{ArrowRight}");
    expect(dirtyGenerate()).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "候補を全消去" }));
    await confirmClear(user);
    expect(dirtyGenerate()).toBeNull();
    expect(screen.getByRole("button", { name: "ルート生成" })).toBeInTheDocument();
  });

  it("走行条件の想定速度と出発時刻を変えると、生成の要求と地図の道の詳細へ同じ値が渡る", async () => {
    const departure = new Date("2026-10-05T09:00:00+09:00");
    // レンズのコマは、出発時刻を含むものだけが別の印を持つ。
    onBackend("GET", "/api/region/time-frames", () =>
      Response.json({
        road_surface: [{ start: "2000-01-01T00:00:00+09:00", end: "2100-01-01T00:00:00+09:00", key: "road" }],
        lens: [
          { start: "2000-01-01T00:00:00+09:00", end: "2026-10-05T08:30:00+09:00", key: "before" },
          { start: "2026-10-05T08:30:00+09:00", end: "2026-10-05T09:30:00+09:00", key: "departure" },
          { start: "2026-10-05T09:30:00+09:00", end: "2100-01-01T00:00:00+09:00", key: "after" },
        ],
      }),
    );
    // 道の窓は、送られた条件が走行条件と同じ（時刻は出発時刻を含むコマの印）ときだけ返す。
    onBackend("POST", "/api/region/road-inspector", ({ body }) => {
      const sent = body as { speed_kmh?: number; frame?: string };
      return sent.speed_kmh === 25 && sent.frame === "departure"
        ? Response.json(inspectorResult())
        : Response.json({ detail: "条件が違う" }, { status: 400 });
    });
    const { user } = renderHome();
    await user.click(screen.getByRole("button", { name: /^想定速度: / }));
    const speed = await screen.findByRole("spinbutton", { name: "想定速度（km/h）" });
    await user.clear(speed);
    await user.type(speed, "25");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /^出発時刻.*（タップで変更）$/ }));
    // 出発日時の入力は日本時間で読む。
    fireEvent.change(await screen.findByLabelText("出発日時を直接指定"), { target: { value: "2026-10-05T09:00" } });

    serveRoadsAt([{ at: HERE, properties: { osm_way_id: 1, feature_key: "1" } }]);
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    rightClickMap(HERE);
    expect(await screen.findByText("+12秒")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "パネルを開く" }));
    jobs.respond([FIRST], LOOP_CONDITIONS);
    expect(await generate(user)).toMatchObject({ assumed_speed_kmh: 25, start_time: departure.toISOString() });
  });

  it("保存した条件は地図で置いた出発地を持ち、呼び出すとその出発地から生成する", async () => {
    const PLACED: Coordinates = { latitude: 35.65, longitude: 139.75 };
    const { user } = renderHome();
    // 保存も呼び出しも「保存済み」タブで行う（隠れたタブの中身も描いてあるので、ほかのタブにも保存のボタンがあれば、ボタンが2つに
    // 当たって落ちる）。
    const saveAs = async (name: string) => {
      await user.click(screen.getByRole("tab", { name: "保存済み" }));
      const saveButton = screen.getByRole("button", { name: "いまの設定を保存" });
      expect(screen.getByRole("tabpanel", { name: "保存済み" })).toContainElement(saveButton);
      await user.click(saveButton);
      const dialog = screen.getByRole("dialog", { name: "いまの設定を保存" });
      const nameInput = within(dialog).getByRole("textbox", { name: "保存する名前" });
      await user.clear(nameInput);
      await user.type(nameInput, name);
      await user.click(within(dialog).getByRole("button", { name: "保存" }));
    };
    const recall = async (name: string) => {
      await user.click(screen.getByRole("tab", { name: "保存済み" }));
      await user.click(screen.getByRole("tab", { name: "設定" }));
      await user.click(screen.getByRole("button", { name: `「${name}」を呼び出す` }));
      await user.click(
        within(screen.getByRole("dialog", { name: `「${name}」を反映します` })).getByRole("button", {
          name: "反映する",
        }),
      );
    };
    const origin = (body: Record<string, unknown>) => ({ latitude: body.latitude, longitude: body.longitude });

    clickMap(PLACED);
    await saveAs("置いた所");
    await user.click(screen.getByRole("tab", { name: "条件" }));
    await user.click(screen.getByRole("button", { name: "出発地を現在地に戻す" }));

    jobs.respond([FIRST], LOOP_CONDITIONS);
    await recall("置いた所");
    expect(origin(await generate(user))).toEqual(PLACED);
  });

  it("「走りにくさ」タブで選んだ全体の割合と無効にした軸が、生成の要求に載る", async () => {
    serveCostAxisCatalog();
    const { user } = renderHome();
    await user.click(screen.getByRole("tab", { name: "走りにくさ" }));
    await user.click(
      within(screen.getByRole("radiogroup", { name: "全体の割合" })).getByRole("radio", { name: "150%" }),
    );
    await user.click(
      within(await screen.findByRole("radiogroup", { name: "振動の割合" })).getByRole("radio", { name: "無効" }),
    );

    jobs.respond([FIRST], LOOP_CONDITIONS);
    expect((await generate(user)).cost_preference).toEqual({
      strength: 1.5,
      multipliers: {},
      disabled_axes: ["vibration"],
    });
  });

  it("走りにくさを説明する文の軸の並びと、ルートの後に選ばずに塗る総合の名前は、費用の軸の一覧の名前で出る", async () => {
    const catalog = costAxisCatalog(costAxisEntry("first", { label: "甲" }), costAxisEntry("second", { label: "乙" }));
    serveCostAxisCatalog({ ...catalog, total_lens: { ...catalog.total_lens, label: "全部" } });
    const { user } = renderHome();

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "走りにくさ" })).toHaveAttribute(
        "data-usage",
        expect.stringContaining("走りにくさ[甲・乙]を"),
      ),
    );
    await user.click(screen.getByRole("tab", { name: "走りにくさ" }));
    await user.click(screen.getByRole("button", { name: "全体の説明を表示" }));
    expect(await screen.findByText(/走りにくさ\[甲・乙\]は、/)).toBeInTheDocument();
    await user.keyboard("{Escape}");

    jobs.respond([FIRST], LOOP_CONDITIONS);
    await generate(user);
    expect(
      await screen.findByRole("button", { name: "走りにくさを色で見る: 全部（タップで変更）" }),
    ).toBeInTheDocument();
  });

  it("「走りにくさ」タブで無効にした軸は、「走りにくさを色で見る」の一覧に出ない", async () => {
    const { user } = renderHome();
    await user.click(screen.getByRole("tab", { name: "走りにくさ" }));
    await user.click(
      within(await screen.findByRole("radiogroup", { name: "振動の割合" })).getByRole("radio", { name: "無効" }),
    );
    await user.click(screen.getByRole("button", { name: "パネルを閉じる" }));
    await user.click(screen.getByRole("button", { name: /^走りにくさを色で見る/ }));
    const options = await screen.findByRole("radiogroup", { name: "走りにくさを色で見る" });
    const names = within(options)
      .getAllByRole("radio")
      .map((row) => row.textContent ?? "")
      .join(" ");

    expect(names).not.toContain("振動");
    expect(names).toContain("登坂");
  });

  it("「道路」タブの段は、タブを出していて「地図で見る」がONの間だけ地図の道に塗る", async () => {
    serveClientConfig(
      clientConfigResponse({
        road_classes: roadClassCatalog({
          avoidance: {
            levels: AVOIDANCE_LEVELS,
            sections: [{ key: "surface", label: "路面" }],
            rows: [avoidanceRow("surface.gravel", "surface", { default: "avoid" })],
          },
        }),
      }),
    );
    const { user } = renderHome();
    const painted = () =>
      mapOnScreen().visibleLayerIds().includes(sceneLayerId(ROAD_LINE_SOURCE_ID, ROAD_AVOIDANCE_ROLE));
    const onMap = () => screen.getByRole("checkbox", { name: "地図で見る" });

    await user.click(screen.getByRole("tab", { name: ROAD_SETTINGS_TAB_NAME }));
    await waitFor(() => expect(painted()).toBe(true));
    await user.click(onMap());
    expect(painted()).toBe(false);
    await user.click(onMap());
    expect(painted()).toBe(true);
    await user.click(screen.getByRole("tab", { name: "条件" }));
    expect(painted()).toBe(false);
  });
});
