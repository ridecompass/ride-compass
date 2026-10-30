/**
 * `features/conditions/WeatherPanel/GridPointToday.tsx`——観測値のパネルの中に出す、最寄りの格子点の今日の値。
 *
 * 見るもの: 格子点の方位と距離・1時間ごとの値の幅・時刻ごとの値・計算値の断り、風の矢印の向き、取得に失敗したときの文。
 *
 * ここで見ないもの: パネルを開くこと → `WeatherPanel.test.tsx`。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { mapDisplay } from "@/types/generated/mapDisplay";
import type { GridPointToday as GridPointTodayValues } from "@/types/weather";

import GridPointToday from "./GridPointToday";

const gridPointToday = (overrides: Partial<GridPointTodayValues> = {}): GridPointTodayValues => ({
  latitude: 35.75,
  longitude: 139.6875,
  distance_km: 3.24,
  bearing_deg: 45,
  times: ["2026-09-24T22:00", "2026-09-24T23:00"],
  temperature_c: [18.2, 17.6],
  precipitation_mm: [0, 1.2],
  wind_speed_ms: [2.4, 5.1],
  wind_direction_deg: [90, null],
  highest_hourly_temperature_c: 18.2,
  lowest_hourly_temperature_c: 17.6,
  highest_hourly_precipitation_mm: 1.2,
  highest_hourly_wind_speed_ms: 5.1,
  ...overrides,
});

describe("GridPointToday", () => {
  it("最寄りの格子点の方位と距離・1時間ごとの値の幅・時刻ごとの値・計算値の断りを出す", () => {
    render(<GridPointToday today={gridPointToday()} error={null} mapBearingDeg={0} />);

    const today = screen.getByRole("region", { name: "今日・最寄りの格子点の値" });
    expect(today).toHaveTextContent("北東3.2km先の格子点");
    expect(today).toHaveTextContent("17.6〜18.2℃");
    expect(today).toHaveTextContent("〜1.2mm");
    expect(today).toHaveTextContent("〜5.1m/s");
    expect(today).toHaveTextContent(mapDisplay.modelValueDisclaimer);
    const rows = Array.from(today.querySelectorAll("tr")).map((row) =>
      Array.from(row.children).map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ["時刻", "22時", "23時"],
      ["気温（℃）", "18.2", "17.6"],
      ["降水量（mm）", "-", "1.2"],
      ["風速（m/s）", "2.4", "5.1"],
    ]);
  });

  it("風の矢印は、吹いていく向きを地図の向きに合わせて指す", () => {
    render(<GridPointToday today={gridPointToday()} error={null} mapBearingDeg={30} />);

    const wind = screen.getByRole("rowheader", { name: "風速（m/s）" }).parentElement!;
    const arrows = wind.querySelectorAll<HTMLElement>("[style]");
    expect(Array.from(arrows).map((arrow) => arrow.style.transform)).toEqual(["rotate(240deg)"]);
  });

  it("取得に失敗したら、その旨だけを出す", () => {
    render(<GridPointToday today={null} error="混雑しています" mapBearingDeg={0} />);

    expect(screen.getByText("最寄りの格子点の今日の値を取得できませんでした。")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "今日・最寄りの格子点の値" })).not.toBeInTheDocument();
  });
});
