import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jst } from "@/testing/jst";
import { vocabulary } from "@/types/generated/vocabulary";
import type { AmedasObservation } from "@/types/weather";

import WeatherPanel from "./WeatherPanel";

const NOW = jst("2026-09-24T12:00");

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
    const mark = screen.getByRole("img", { name: "観測値を取得できません" });
    expect(mark).toHaveTextContent(/^$/);
    expect(mark).toHaveAttribute("data-usage", expect.stringContaining("混雑しています"));
  });

  it("観測値があれば、直近の失敗でも観測値を出す", () => {
    renderPanel({ amedas: observation(), error: "混雑しています" });
    expect(screen.getByText("気温:").parentElement).toHaveTextContent("21.4℃");
  });

  it("観測値も失敗も無ければ何も出さない", () => {
    const { container } = renderPanel();
    expect(container).toBeEmptyDOMElement();
  });
});

describe("WeatherPanel 観測値", () => {
  it("気温・風速と風向・10分間の降水量を小数1桁で出す", () => {
    renderPanel({ amedas: observation({ precipitation_10min_mm: 1.25 }) });
    expect(screen.getByText("気温:").parentElement).toHaveTextContent("21.4℃");
    expect(screen.getByText("東の風:").parentElement).toHaveTextContent("3.3m/s");
    expect(screen.getByText("降水量:").parentElement).toHaveTextContent("1.3mm");
  });

  // 風の矢印は吹いていく向き（来る向きの反対）を、走りの帯と同じく地図の上の基準で指す。
  it("東の風の矢印は地図の向きに合わせて回す", () => {
    renderPanel({ mapBearingDeg: 30, amedas: observation() });
    const wind = screen.getByText("東の風:").parentElement!;
    expect((wind.firstElementChild as HTMLElement).style.transform).toBe("rotate(240deg)");
  });

  it.each([
    { missing: "なし", overrides: {}, expected: ["気温", "|", "東の風", "|", "降水量", "|", "天気"] },
    {
      missing: "風・降水量・天気",
      overrides: { wind_speed_ms: null, precipitation_10min_mm: null, weather_code: null },
      expected: ["気温"],
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
    const dayIcon = screen.getByText(/^天気:/).parentElement!.innerHTML;
    unmount();
    vi.setSystemTime(jst("2026-09-24T20:00"));
    renderPanel({ amedas: observation() });
    expect(screen.getByText(/^天気:/).parentElement!.innerHTML).not.toBe(dayIcon);
  });

  it("日の出・日の入りが分からなければ昼として扱う", () => {
    vi.setSystemTime(jst("2026-09-24T20:00"));
    const { unmount } = renderPanel({ amedas: observation({ twilight: null }) });
    const unknown = screen.getByText(/^天気:/).parentElement!.innerHTML;
    unmount();
    vi.setSystemTime(NOW);
    renderPanel({ amedas: observation() });
    expect(screen.getByText(/^天気:/).parentElement!.innerHTML).toBe(unknown);
  });

  it("天気を決められなければ、天気は出さない", () => {
    renderPanel({ amedas: observation({ precipitation_10min_mm: null, weather_code: null }) });
    expect(screen.queryByText(/^天気:/)).not.toBeInTheDocument();
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
    expect(screen.queryByText("アメダスの観測")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /気温:/ }));

    const panel = screen.getByRole("dialog");
    expect(panel).toHaveTextContent("アメダスの観測");
    expect(panel).toHaveTextContent("練馬11:50");
    expect(panel).toHaveTextContent("気温21.4℃（体感 20.0℃）");
    expect(panel).toHaveTextContent("風東の風 3.3m/s");
    expect(panel).toHaveTextContent("降水量1.3mm（直近10分間）");
    const clear = vocabulary.weatherCategories.find((category) => category.key === "clear")!;
    expect(panel).toHaveTextContent(`天気${clear.label}`);
  });

  it("日の出・日没は日本時間で出し、読めない時刻は「--:--」", async () => {
    renderPanel({ amedas: observation({ twilight: { sunrise: "2026-09-23T20:30:00Z", sunset: "壊れた値" } }) });

    await userEvent.click(screen.getByRole("button", { name: /気温:/ }));

    expect(screen.getByRole("dialog")).toHaveTextContent("日の出・日没05:30〜--:--");
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

    await userEvent.click(screen.getByRole("button", { name: /気温:/ }));

    const panel = screen.getByRole("dialog");
    expect(panel).toHaveTextContent("気温-℃");
    expect(panel).not.toHaveTextContent("体感");
    expect(panel).not.toHaveTextContent("風");
    expect(panel).not.toHaveTextContent("降水量");
    expect(panel).not.toHaveTextContent("天気");
    expect(panel).not.toHaveTextContent("日の出");
  });
});
