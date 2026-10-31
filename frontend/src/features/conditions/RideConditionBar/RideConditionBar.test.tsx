import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLIENT_TUNING_IDS } from "@/lib/axisCatalog";
import { getQueryClient } from "@/lib/queryClient";
import { serveAxisCatalog } from "@/testing/backendServer";
import { catalogResponse, dedicatedEntry } from "@/testing/catalogAxes";
import { jst } from "@/testing/jst";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

import { LENS_LINK_DESCRIPTION } from "@/lib/lensLink";

import RideConditionBar from "./RideConditionBar";

// 時刻のルーラーのドラッグはEmbla（ライブラリ）の持ち物。ここでは位置合わせを受けるだけの代役にする。
vi.mock("embla-carousel-react", () => ({
  default: () => [() => {}, { scrollTo: vi.fn(), on: vi.fn(), off: vi.fn(), selectedScrollSnap: () => 0 }],
}));
vi.mock("embla-carousel-wheel-gestures", () => ({ WheelGesturesPlugin: () => ({}) }));
// 速度を変える条件の並びはbackendの走行モデルの宣言。架空の並びへ差し替え、説明がそれを書くことを見る。
vi.mock("@/types/generated/route-generate-config.json", async (importOriginal) => {
  const original = await importOriginal<{ default: typeof routeGenerateConfig }>();
  return { default: { ...original.default, segment_speed_conditions: ["条件ア", "条件イ"] } };
});

const NOW = jst("2026-09-24T09:07");
const { max_assumed_speed_kmh: MAX } = routeGenerateConfig;

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  serveAxisCatalog(catalogResponse([]));
});

afterEach(() => {
  vi.useRealTimers();
});

type Props = React.ComponentProps<typeof RideConditionBar>;

function renderBar(overrides: Partial<Props> = {}) {
  const props: Props = {
    departureTime: jst("2026-09-24T09:05"),
    onDepartureTimeChange: vi.fn(),
    onDepartureNow: vi.fn(),
    speedKmh: 20,
    onSpeedKmhChange: vi.fn(),
    linkedDeparture: false,
    linkedSpeed: false,
    ...overrides,
  };
  render(<RideConditionBar {...props} />);
  return props;
}

/** 出発時刻のポップオーバーを開き、刻みを渡されたらその刻みへ切り替える。 */
async function openRuler(step?: string) {
  await userEvent.click(screen.getByRole("button", { name: /^出発時刻:/ }));
  if (step) await userEvent.click(await screen.findByRole("radio", { name: step }));
  else await screen.findByRole("slider", { name: "出発時刻" });
}

describe("RideConditionBar 出発時刻", () => {
  it.each([
    ["今日は時刻だけを1行", "2026-09-24T09:05", "9:05", ["9:05"]],
    ["別の日は日付と時刻を2行に分けて（列の幅に収める）", "2026-09-25T13:00", "9/25 13:00", ["9/25", "13:00"]],
  ])("出発時刻を、%s出す", (_case, departure, label, lines) => {
    renderBar({ departureTime: jst(departure) });
    const button = screen.getByRole("button", { name: `出発時刻: ${label}（タップで変更）` });
    expect([...button.lastElementChild!.children].map((line) => line.textContent)).toEqual(lines);
  });

  it("開くと、日時の入力欄に日本時間で今の出発時刻を入れて出し、直接指定した日時を日本時間として渡す", async () => {
    const props = renderBar();
    await userEvent.click(screen.getByRole("button", { name: /^出発時刻:/ }));
    const input = await screen.findByLabelText("出発日時を直接指定");
    expect(input).toHaveValue("2026-09-24T09:05");
    fireEvent.change(input, { target: { value: "2026-09-26T07:30" } });
    expect(props.onDepartureTimeChange).toHaveBeenCalledWith(jst("2026-09-26T07:30"));
  });

  it.each([
    [
      "出発時刻で値の変わる評価があれば、その名前で",
      ["at", "bearing_deg"],
      "always",
      "ルートの「評価A」の評価・到達予想の時刻に使います。",
    ],
    ["無ければ評価に触れずに", ["bearing_deg"], "always", "ルートの到達予想の時刻に使います。"],
  ] as const)("出発時刻の説明は、%s何に使うかを書く", async (_case, conditions, timeScope, tail) => {
    serveAxisCatalog(
      catalogResponse([
        dedicatedEntry("a", [1], {
          label: "評価A",
          dynamic_way_value_conditions: [...conditions],
          time_scope: timeScope,
        }),
      ]),
    );
    renderBar();
    await waitFor(() => expect(getQueryClient().isFetching()).toBe(0));
    expect(screen.getByRole("button", { name: /^出発時刻:/ })).toHaveAttribute(
      "data-usage",
      `出発する日時を決めます。地図の気象の表示の時刻と、${tail}`,
    );
  });

  it("入力欄を空にしても、出発時刻は変えない", async () => {
    const props = renderBar();
    await userEvent.click(screen.getByRole("button", { name: /^出発時刻:/ }));
    fireEvent.change(await screen.findByLabelText("出発日時を直接指定"), { target: { value: "" } });
    expect(props.onDepartureTimeChange).not.toHaveBeenCalled();
  });

  it("覚えた刻みが無ければ1時間刻みで開き、「今」の次は正時で、今の出発時刻に最も近いコマを選んだ状態にする", async () => {
    const props = renderBar({ departureTime: jst("2026-09-24T10:20") });
    await openRuler();
    expect(screen.getByRole("radio", { name: "1時間" })).toBeChecked();
    // 目盛りは開いた時刻（9:07）を5分刻みへ切り下げた9:05、その先は10:00・11:00…。10:20に最も近いのは10:00。
    expect(screen.getByRole("slider", { name: "出発時刻" })).toHaveAttribute("aria-valuetext", "9/24 10:00");
    await userEvent.click(screen.getByRole("button", { name: "出発時刻を1つ次へ" }));
    expect(props.onDepartureTimeChange).toHaveBeenCalledWith(jst("2026-09-24T11:00"));
  });

  it("刻みを切り替えると「今」へ戻し、選んだ刻みは画面を開き直しても残る", async () => {
    const props = renderBar({ departureTime: jst("2026-09-24T11:00") });
    await openRuler("5分");
    expect(props.onDepartureNow).toHaveBeenCalled();
    expect(props.onDepartureTimeChange).not.toHaveBeenCalled();
    cleanup();

    renderBar();
    await openRuler();
    expect(screen.getByRole("radio", { name: "5分" })).toBeChecked();
  });

  it("閉じて開き直すと、開き直した時刻から目盛りを作り直す", async () => {
    renderBar({ departureTime: jst("2026-09-24T09:05") });
    const trigger = screen.getByRole("button", { name: /^出発時刻:/ });
    await userEvent.click(trigger);
    await userEvent.click(trigger);
    vi.setSystemTime(jst("2026-09-24T10:02"));
    await userEvent.click(trigger);
    // 目盛りは開き直した10:00から始まり、9:05に最も近いのは先頭の10:00。
    expect(await screen.findByRole("slider", { name: "出発時刻" })).toHaveAttribute("aria-valuetext", "9/24 10:00");
  });

  it("「今」の目盛りを選び直したら、その時刻に固定せず「今」への追従へ戻す（放置して過去になり、予報から外れないように）", async () => {
    const props = renderBar({ departureTime: jst("2026-09-24T10:00") });
    await openRuler();
    // 開いた9:07の「今」の目盛りは9:05。10:00から1つ前へ戻すとそこに当たる。
    await userEvent.click(screen.getByRole("button", { name: "出発時刻を1つ前へ" }));
    expect(props.onDepartureNow).toHaveBeenCalled();
    expect(props.onDepartureTimeChange).not.toHaveBeenCalled();
  });

  it("目盛りの端では1コマ送りを押せず、「現在に戻す」は文字の無いアイコンで、今のコマを見ていない間だけ押せる", async () => {
    renderBar();
    await openRuler();
    expect(screen.getByText("9/24 09:05", { selector: "div" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "出発時刻を1つ前へ" })).toBeDisabled();
    const backToNow = screen.getByRole("button", { name: "出発時刻を現在に戻す" });
    expect(backToNow).toBeDisabled();
    expect(backToNow).toHaveTextContent(/^$/);
    cleanup();

    // 予報を読む先より後の出発時刻は、最後の目盛りに寄る。
    const props = renderBar({ departureTime: jst("2026-12-31T00:00") });
    await openRuler();
    expect(screen.getByRole("button", { name: "出発時刻を1つ次へ" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "出発時刻を現在に戻す" }));
    expect(props.onDepartureNow).toHaveBeenCalled();
  });

  it("刻みの後半に開いても、「今」の目盛りは今を刻みへ切り下げた時刻で、5分刻みなら1つ次へ5分送れる", async () => {
    // 9:08は9:05より9:10に近いが、「今」に追従する出発時刻は9:05へ切り下げてある。
    vi.setSystemTime(jst("2026-09-24T09:08"));
    const props = renderBar({ departureTime: jst("2026-09-24T09:05") });
    await openRuler("5分");
    await userEvent.click(screen.getByRole("button", { name: "出発時刻を1つ次へ" }));
    expect(props.onDepartureTimeChange).toHaveBeenCalledWith(jst("2026-09-24T09:10"));
  });
});

describe("RideConditionBar 想定速度", () => {
  it("スライダーで動かした値を渡す", async () => {
    const props = renderBar();
    await userEvent.click(screen.getByRole("button", { name: /^想定速度:/ }));
    fireEvent.change(await screen.findByRole("slider", { name: "想定速度スライダー" }), { target: { value: "24" } });
    expect(props.onSpeedKmhChange).toHaveBeenCalledWith(24);
  });

  it("数値欄の範囲の外の値は、範囲へ収めて渡す", async () => {
    const props = renderBar();
    await userEvent.click(screen.getByRole("button", { name: /^想定速度:/ }));
    const input = await screen.findByLabelText("想定速度（km/h）");
    await userEvent.clear(input);
    await userEvent.type(input, `${MAX + 10}{Enter}`);
    expect(props.onSpeedKmhChange).toHaveBeenCalledWith(MAX);
  });

  it("(i)の奥に、走行モデルが速度を変える条件として宣言する並びを書く", async () => {
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: /^想定速度:/ }));
    await userEvent.click(await screen.findByRole("button", { name: "想定速度の説明を表示" }));
    expect(await screen.findByText(/区間ごとの条件ア・条件イで速度を変えて計算します/)).toBeInTheDocument();
  });

  it("(i)の奥に、軸カタログが配る体格・機材の標準値を書く", async () => {
    serveAxisCatalog(
      catalogResponse([], {
        client_tuning: {
          [CLIENT_TUNING_IDS.massKg]: 72,
          [CLIENT_TUNING_IDS.cdaM2]: 0.4,
          [CLIENT_TUNING_IDS.maxDescentKmh]: 50,
          [CLIENT_TUNING_IDS.walkingKmh]: 5,
        },
      }),
    );
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: /^想定速度:/ }));
    await userEvent.click(await screen.findByRole("button", { name: "想定速度の説明を表示" }));
    expect(await screen.findByText(/総質量72kg.*CdA 0.4m².*下りは50km\/hまで.*5km\/h以下/)).toBeInTheDocument();
  });

  it("体格・機材の標準値を軸カタログから1つでも引けなければ、標準値の文を出さない", async () => {
    serveAxisCatalog(
      catalogResponse([], {
        client_tuning: {
          [CLIENT_TUNING_IDS.massKg]: 72,
          [CLIENT_TUNING_IDS.cdaM2]: 0.4,
          [CLIENT_TUNING_IDS.maxDescentKmh]: 50,
        },
      }),
    );
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: /^想定速度:/ }));
    await userEvent.click(await screen.findByRole("button", { name: "想定速度の説明を表示" }));
    expect(await screen.findByText(/平らな道を風の無いときに巡航する速度です/)).toBeInTheDocument();
    // 軸カタログが届いてから確かめる（届く前も文を出さないので、届く前に見ると引けたかを見分けない）。
    await waitFor(() => expect(getQueryClient().isFetching()).toBe(0));
    expect(screen.queryByText(/標準値で計算します/)).not.toBeInTheDocument();
  });
});

describe("RideConditionBar 地図の塗りとの結び", () => {
  it.each([
    [{ linkedDeparture: true, linkedSpeed: false }, [LENS_LINK_DESCRIPTION, null]],
    [{ linkedDeparture: false, linkedSpeed: true }, [null, LENS_LINK_DESCRIPTION]],
  ])("いまの地図の塗りが決まっている条件（%j）のボタンにだけ、そう添える", (linked, descriptions) => {
    renderBar(linked);
    const buttons = [
      screen.getByRole("button", { name: /^出発時刻:/ }),
      screen.getByRole("button", { name: /^想定速度:/ }),
    ];
    expect(buttons.map((button) => button.getAttribute("aria-description"))).toEqual(descriptions);
  });
});
