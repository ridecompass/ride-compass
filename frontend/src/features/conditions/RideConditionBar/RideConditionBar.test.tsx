import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { translate } from "@/i18n/config";
import { jst } from "@/testing/jst";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";

import { LENS_LINK_DESCRIPTION } from "@/lib/lensLink";

import { DEPARTURE_STEPS, type DepartureStep } from "./departureTimeline";
import RideConditionBar from "./RideConditionBar";

// 時刻のルーラーのドラッグはEmbla（ライブラリ）の持ち物。ここでは位置合わせを受けるだけの代役にする。
vi.mock("embla-carousel-react", () => ({
  default: () => [() => {}, { scrollTo: vi.fn(), on: vi.fn(), off: vi.fn(), selectedScrollSnap: () => 0 }],
}));
vi.mock("embla-carousel-wheel-gestures", () => ({ WheelGesturesPlugin: () => ({}) }));

const NOW = jst("2026-09-24T09:07");
const { max_assumed_speed_kmh: MAX } = routeGenerateConfig;
const DEPARTURE = translate("conditions.departure.name");
const SPEED = translate("conditions.speed.name");
const at = (time: string) => translate("conditions.departure.at", { time });
const stepName = (value: DepartureStep) => DEPARTURE_STEPS.find((step) => step.value === value)!.label;
const timeSlider = (id: "previousLabel" | "nextLabel" | "nowLabel") =>
  translate(`conditions.timeSlider.${id}`, { name: DEPARTURE });

/** 値を添えた条件のボタン（「出発時刻」「想定速度」）。 */
function conditionButton(name: string) {
  const prefix = translate("conditions.bar.withValue", { name, value: "" });
  return screen.getByRole("button", { name: (accessibleName) => accessibleName.startsWith(prefix) });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
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
async function openRuler(step?: DepartureStep) {
  await userEvent.click(conditionButton(DEPARTURE));
  if (step) await userEvent.click(await screen.findByRole("radio", { name: stepName(step) }));
  else await screen.findByRole("slider", { name: DEPARTURE });
}

describe("RideConditionBar 出発時刻", () => {
  it.each([
    ["今日は「発」を添えた時刻だけを1行", "2026-09-24T09:05", "9:05", [at("9:05")]],
    ["別の日は日付と時刻を2行に分けて（列の幅に収める）", "2026-09-25T13:00", "9/25 13:00", ["9/25", at("13:00")]],
  ])("出発時刻を、%s出す", (_case, departure, label, lines) => {
    renderBar({ departureTime: jst(departure) });
    const button = screen.getByRole("button", {
      name: translate("conditions.bar.trigger", {
        name: translate("conditions.bar.withValue", { name: DEPARTURE, value: label }),
      }),
    });
    expect([...button.lastElementChild!.children].map((line) => line.textContent)).toEqual(lines);
  });

  it("開くと、見出し「出発の時刻」と日時の入力欄に日本時間で今の出発時刻を入れて出し、直接指定した日時を日本時間として渡す", async () => {
    const props = renderBar();
    await userEvent.click(conditionButton(DEPARTURE));
    const input = await screen.findByLabelText(translate("conditions.departure.input"));
    expect(screen.getByRole("heading", { name: translate("conditions.departure.heading") })).toBeVisible();
    expect(input).toHaveValue("2026-09-24T09:05");
    fireEvent.change(input, { target: { value: "2026-09-26T07:30" } });
    expect(props.onDepartureTimeChange).toHaveBeenCalledWith(jst("2026-09-26T07:30"));
  });

  it("入力欄を空にしても、出発時刻は変えない", async () => {
    const props = renderBar();
    await userEvent.click(conditionButton(DEPARTURE));
    fireEvent.change(await screen.findByLabelText(translate("conditions.departure.input")), { target: { value: "" } });
    expect(props.onDepartureTimeChange).not.toHaveBeenCalled();
  });

  it("覚えた刻みが無ければ1時間刻みで開き、「今」の次は正時で、今の出発時刻に最も近いコマを選んだ状態にする", async () => {
    const props = renderBar({ departureTime: jst("2026-09-24T10:20") });
    await openRuler();
    expect(screen.getByRole("radio", { name: stepName("hour") })).toBeChecked();
    // 目盛りは開いた時刻（9:07）を5分刻みへ切り下げた9:05、その先は10:00・11:00…。10:20に最も近いのは10:00。
    expect(screen.getByRole("slider", { name: DEPARTURE })).toHaveAttribute("aria-valuetext", "9/24 10:00");
    await userEvent.click(screen.getByRole("button", { name: timeSlider("nextLabel") }));
    expect(props.onDepartureTimeChange).toHaveBeenCalledWith(jst("2026-09-24T11:00"));
  });

  it("刻みを切り替えると「今」へ戻し、選んだ刻みは画面を開き直しても残る", async () => {
    const props = renderBar({ departureTime: jst("2026-09-24T11:00") });
    await openRuler("5min");
    expect(props.onDepartureNow).toHaveBeenCalled();
    expect(props.onDepartureTimeChange).not.toHaveBeenCalled();
    cleanup();

    renderBar();
    await openRuler();
    expect(screen.getByRole("radio", { name: stepName("5min") })).toBeChecked();
  });

  it("開いたまま刻みを5分へ切り替えると、目盛りを5分刻みに作り直す", async () => {
    const props = renderBar({ departureTime: jst("2026-09-24T09:05") });
    await openRuler("5min");
    await userEvent.click(screen.getByRole("button", { name: timeSlider("nextLabel") }));
    expect(props.onDepartureTimeChange).toHaveBeenCalledWith(jst("2026-09-24T09:10"));
  });

  it("閉じて開き直すと、開き直した時刻から目盛りを作り直す", async () => {
    renderBar({ departureTime: jst("2026-09-24T09:05") });
    const trigger = conditionButton(DEPARTURE);
    await userEvent.click(trigger);
    await userEvent.click(trigger);
    vi.setSystemTime(jst("2026-09-24T10:02"));
    await userEvent.click(trigger);
    // 目盛りは開き直した10:00から始まり、9:05に最も近いのは先頭の10:00。
    expect(await screen.findByRole("slider", { name: DEPARTURE })).toHaveAttribute("aria-valuetext", "9/24 10:00");
  });

  it("「今」の目盛りを選び直したら、その時刻に固定せず「今」への追従へ戻す（放置して過去になり、予報から外れないように）", async () => {
    const props = renderBar({ departureTime: jst("2026-09-24T10:00") });
    await openRuler();
    // 開いた9:07の「今」の目盛りは9:05。10:00から1つ前へ戻すとそこに当たる。
    await userEvent.click(screen.getByRole("button", { name: timeSlider("previousLabel") }));
    expect(props.onDepartureNow).toHaveBeenCalled();
    expect(props.onDepartureTimeChange).not.toHaveBeenCalled();
  });

  it("目盛りの端では1コマ送りを押せず、「現在に戻す」は文字の無いアイコンで、今のコマを見ていない間だけ押せる", async () => {
    renderBar();
    await openRuler();
    expect(screen.getByText("9/24 09:05", { selector: "div" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: timeSlider("previousLabel") })).toBeDisabled();
    const backToNow = screen.getByRole("button", { name: timeSlider("nowLabel") });
    expect(backToNow).toBeDisabled();
    expect(backToNow).toHaveTextContent(/^$/);
    cleanup();

    // 予報を読む先より後の出発時刻は、最後の目盛りに寄る。
    const props = renderBar({ departureTime: jst("2026-12-31T00:00") });
    await openRuler();
    expect(screen.getByRole("button", { name: timeSlider("nextLabel") })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: timeSlider("nowLabel") }));
    expect(props.onDepartureNow).toHaveBeenCalled();
  });
});

describe("RideConditionBar 想定速度", () => {
  it("スライダーで動かした値を渡す", async () => {
    const props = renderBar();
    await userEvent.click(conditionButton(SPEED));
    fireEvent.change(await screen.findByRole("slider", { name: translate("conditions.speed.slider") }), {
      target: { value: "24" },
    });
    expect(props.onSpeedKmhChange).toHaveBeenCalledWith(24);
  });

  it("数値欄の範囲の外の値は、範囲へ収めて渡す", async () => {
    const props = renderBar();
    await userEvent.click(conditionButton(SPEED));
    const input = await screen.findByLabelText(translate("conditions.speed.input"));
    await userEvent.clear(input);
    await userEvent.type(input, `${MAX + 10}{Enter}`);
    expect(props.onSpeedKmhChange).toHaveBeenCalledWith(MAX);
  });
});

describe("RideConditionBar 地図の塗りとの結び", () => {
  it.each([
    [{ linkedDeparture: true, linkedSpeed: false }, [LENS_LINK_DESCRIPTION, null]],
    [{ linkedDeparture: false, linkedSpeed: true }, [null, LENS_LINK_DESCRIPTION]],
  ])("いまの地図の塗りが決まっている条件（%j）のボタンにだけ、そう添える", (linked, descriptions) => {
    renderBar(linked);
    const buttons = [conditionButton(DEPARTURE), conditionButton(SPEED)];
    expect(buttons.map((button) => button.getAttribute("aria-description"))).toEqual(descriptions);
  });
});
