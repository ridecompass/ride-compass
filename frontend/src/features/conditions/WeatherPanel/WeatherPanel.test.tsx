import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { translate } from "@/i18n/config";
import { jst } from "@/testing/jst";
import { vocabulary } from "@/types/generated/vocabulary";
import type { AmedasObservation } from "@/types/weather";

import WeatherPanel from "./WeatherPanel";

const NOW = jst("2026-09-24T12:00");

const TEMPERATURE = translate("conditions.weather.temperature");
const PRECIPITATION = translate("conditions.weather.precipitation");
const WEATHER = translate("conditions.weather.weather");
/** 読み上げだけに出す項目の名前（「気温:」等）。 */
const stat = (term: string) => translate("conditions.weather.stat", { term }).trim();
/** 観測値を押すと開くボタン。名前は出ている項目を並べたもの。 */
const statsButton = () => screen.getByRole("button", { name: (name) => name.includes(stat(TEMPERATURE)) });
/** 項目の名前で始まる読み上げの文を持つ要素。 */
const statStartingWith = (term: string) => screen.getByText((content) => content.startsWith(stat(term)));

const observation = (overrides: Partial<AmedasObservation> = {}) =>
  ({
    station_name: "東京",
    observed_at: "2026-09-24T11:50:00+09:00",
    temperature_c: 21.44,
    apparent_temperature_c: 19.96,
    wind_speed_ms: 3.25,
    wind_direction: { deg: 90, label: "東" },
    precipitation_10min_mm: 0,
    weather_code: 0,
    twilight: { sunrise: "2026-09-24T05:30:00+09:00", sunset: "2026-09-24T17:40:00+09:00" },
    ...overrides,
  }) as AmedasObservation;

function renderPanel(props: Partial<ComponentProps<typeof WeatherPanel>> = {}) {
  return render(
    <WeatherPanel mapBearingDeg={0} amedas={null} error={null} today={null} todayError={null} {...props} />,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WeatherPanel 取得の状態", () => {
  it("観測値が無く失敗したら、取得できないことを文字の無い印で出し、理由は使い方の文に回す", () => {
    renderPanel({ error: "混雑しています" });
    const mark = screen.getByRole("img", { name: translate("conditions.weather.failedLabel") });
    expect(mark).toHaveTextContent(/^$/);
    expect(mark).toHaveAttribute("data-usage", expect.stringContaining("混雑しています"));
  });

  it("観測値があれば、直近の失敗でも観測値を出す", () => {
    renderPanel({ amedas: observation(), error: "混雑しています" });
    expect(screen.getByText(stat(TEMPERATURE)).parentElement).toHaveTextContent("21.4℃");
  });

  it("観測値も失敗も無ければ何も出さない", () => {
    const { container } = renderPanel();
    expect(container).toBeEmptyDOMElement();
  });
});

describe("WeatherPanel 観測値", () => {
  it("気温・風速と風向・10分間の降水量を小数1桁で出す", () => {
    renderPanel({ amedas: observation({ precipitation_10min_mm: 1.25 }) });
    expect(screen.getByText(stat(TEMPERATURE)).parentElement).toHaveTextContent("21.4℃");
    expect(screen.getByText("東の風:").parentElement).toHaveTextContent("3.3m/s");
    expect(screen.getByText(stat(PRECIPITATION)).parentElement).toHaveTextContent("1.3mm");
  });

  // 風の矢印は吹いていく向き（来る向きの反対）を、走りの帯と同じく地図の上の基準で指す。
  it("東の風の矢印は地図の向きに合わせて回す", () => {
    renderPanel({ mapBearingDeg: 30, amedas: observation() });
    const wind = screen.getByText("東の風:").parentElement!;
    expect((wind.firstElementChild as HTMLElement).style.transform).toBe("rotate(240deg)");
  });

  it.each([
    { missing: "なし", overrides: {}, expected: [TEMPERATURE, "|", "東の風", "|", PRECIPITATION, "|", WEATHER] },
    {
      missing: "風・降水量・天気",
      overrides: { wind_speed_ms: null, precipitation_10min_mm: null, weather_code: null },
      expected: [TEMPERATURE],
    },
  ])("区切り線は、出ている項目どうしの間にだけ出る（欠け: $missing）", ({ overrides, expected }) => {
    renderPanel({ amedas: observation(overrides) });
    const row = screen.getByRole("button").firstElementChild!;
    const shown = Array.from(row.children).map((child) =>
      child.getAttribute("aria-hidden") === "true" ? "|" : child.querySelector(".sr-only")!.textContent!.split(":")[0],
    );
    expect(shown).toEqual(expected);
  });

  it("天気はbackendが実測から導いたコードで出し、日の出から日の入りまでを昼とする", () => {
    const { unmount } = renderPanel({ amedas: observation() });
    const dayIcon = statStartingWith(WEATHER).parentElement!.innerHTML;
    unmount();
    vi.setSystemTime(jst("2026-09-24T20:00"));
    renderPanel({ amedas: observation() });
    expect(statStartingWith(WEATHER).parentElement!.innerHTML).not.toBe(dayIcon);
  });

  it("日の出・日の入りが分からなければ昼として扱う", () => {
    vi.setSystemTime(jst("2026-09-24T20:00"));
    const { unmount } = renderPanel({ amedas: observation({ twilight: null }) });
    const unknown = statStartingWith(WEATHER).parentElement!.innerHTML;
    unmount();
    vi.setSystemTime(NOW);
    renderPanel({ amedas: observation() });
    expect(statStartingWith(WEATHER).parentElement!.innerHTML).toBe(unknown);
  });
});

describe("WeatherPanel 観測の出所", () => {
  it("観測値を押すと、アメダスの観測であることと観測所名・観測の時刻（日本時間）、数値ごとの意味が開く", async () => {
    renderPanel({
      amedas: observation({
        station_name: "練馬",
        observed_at: "2026-09-24T02:50:00Z",
        precipitation_10min_mm: 1.25,
      }),
    });

    await userEvent.click(statsButton());

    const panel = screen.getByRole("dialog");
    expect(panel).toHaveTextContent("練馬11:50");
    expect(panel).toHaveTextContent(
      `${TEMPERATURE}21.4℃${translate("conditions.weather.apparent", { value: "20.0" })}`,
    );
    expect(panel).toHaveTextContent(
      `${translate("conditions.weather.wind")}${translate("conditions.weather.windValue", { direction: "東", speed: "3.3" })}`,
    );
    expect(panel).toHaveTextContent(
      `${PRECIPITATION}${translate("conditions.weather.precipitationValue", { value: "1.3" })}`,
    );
    const clear = vocabulary.weatherCategories.find((category) => category.key === "clear")!;
    expect(panel).toHaveTextContent(`${WEATHER}${clear.label}`);
  });

  it("日の出・日没は日本時間で出し、読めない時刻は「--:--」", async () => {
    renderPanel({ amedas: observation({ twilight: { sunrise: "2026-09-23T20:30:00Z", sunset: "壊れた値" } }) });

    await userEvent.click(statsButton());

    expect(screen.getByRole("dialog")).toHaveTextContent(`${translate("conditions.weather.twilight")}05:30〜--:--`);
  });

  it("体感温度・風・降水量・天気・日の出と日没が無ければ、パネルにもその行を出さない", async () => {
    renderPanel({
      amedas: observation({
        temperature_c: null,
        apparent_temperature_c: null,
        wind_speed_ms: null,
        precipitation_10min_mm: null,
        weather_code: null,
        twilight: null,
      }),
    });

    await userEvent.click(statsButton());

    const panel = screen.getByRole("dialog");
    expect(panel).toHaveTextContent(`${TEMPERATURE}-℃`);
    const apparentPrefix = translate("conditions.weather.apparent", { value: "\0" }).split("\0")[0];
    for (const absent of [apparentPrefix, translate("conditions.weather.wind"), PRECIPITATION, WEATHER]) {
      expect(panel).not.toHaveTextContent(absent);
    }
    expect(panel).not.toHaveTextContent(translate("conditions.weather.twilight"));
  });
});
