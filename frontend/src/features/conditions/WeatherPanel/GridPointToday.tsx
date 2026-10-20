import type { ReactNode } from "react";
import {
  RaindropIcon,
  SelectedSpotIcon,
  ThermometerIcon,
  WindDirectionArrowIcon,
  WindIcon,
} from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import { cardinalLabel, downwindOnMapDeg } from "@/lib/cardinalLabel";
import { cn } from "@/lib/cn";
import { jstParts, parseJstLocalValue } from "@/lib/time";
import { mapDisplay } from "@/types/generated/mapDisplay";
import weatherScales from "@/types/generated/weather-scales.json";
import type { GridPointToday as GridPointTodayValues } from "@/types/weather";

interface GridPointTodayProps {
  today: GridPointTodayValues | null;
  error: string | null;
  /** 地図の向き。風の矢印を地図の上の向きに合わせる。 */
  mapBearingDeg: number;
}

function decimal(value: number | null): string {
  return value == null ? "-" : value.toFixed(1);
}

/** 降っていない量は「-」にして、降る時間を目で拾えるようにする。 */
function precipitation(value: number | null): string {
  return value == null || value < weatherScales.precipitation_none_below_mm ? "-" : value.toFixed(1);
}

/** 表の行の見出し。アイコンだけを見せ、項目と単位は読み上げに回す。 */
function RowHead({ name, children }: { name: string; children: ReactNode }) {
  return (
    <th scope="row" className="sticky left-0 bg-[var(--color-surface)] pr-1 font-normal text-[var(--color-muted)]">
      {children}
      <span className="sr-only">{name}</span>
    </th>
  );
}

// 値は利用者の地点ではなく、最寄りの格子点の値そのもの。地点の値と読ませないよう、格子点の方位と距離を見出しの隣に置く。
// 最も高い・低い値は、並べた1時間ごとの値の幅として出し、日の最高・最低気温と読める名前にしない。
export default function GridPointToday({ today, error, mapBearingDeg }: GridPointTodayProps) {
  if (!today) {
    if (!error) return null;
    return (
      <p className={cn(textVariants({ variant: "note" }), "mt-2 border-t border-[var(--color-border)] pt-2")}>
        最寄りの格子点の今日の値を取得できませんでした。
      </p>
    );
  }

  const hours = today.times.map((time) => `${jstParts(parseJstLocalValue(time)).hour}時`);

  return (
    <section aria-label="今日・最寄りの格子点の値" className="mt-2 border-t border-[var(--color-border)] pt-2">
      <div className="flex items-center justify-between gap-2">
        <p className={cn(textVariants({ variant: "note" }), "font-bold tracking-wide")}>今日・最寄りの格子点の値</p>
        <span className="inline-flex flex-shrink-0 items-center gap-0.5 rounded-full border border-[var(--color-border)] px-1.5 text-[length:var(--font-size-xs)] tabular-nums">
          <SelectedSpotIcon size={12} />
          {cardinalLabel(today.bearing_deg)}へ約{today.distance_km.toFixed(1)}km
        </span>
      </div>
      <p className="mt-1 flex flex-wrap gap-x-3 font-semibold tabular-nums">
        <span className="sr-only">1時間ごとの値の幅: </span>
        <span className="inline-flex items-center gap-0.5">
          <ThermometerIcon size={14} />
          <span className="sr-only">気温 </span>
          {decimal(today.lowest_hourly_temperature_c)}〜{decimal(today.highest_hourly_temperature_c)}℃
        </span>
        <span className="inline-flex items-center gap-0.5">
          <RaindropIcon size={14} />
          <span className="sr-only">降水量 最も多い1時間 </span>〜{precipitation(today.highest_hourly_precipitation_mm)}
          mm
        </span>
        <span className="inline-flex items-center gap-0.5">
          <WindIcon size={14} />
          <span className="sr-only">風速 最も強い1時間 </span>〜{decimal(today.highest_hourly_wind_speed_ms)}m/s
        </span>
      </p>
      <div className="mt-1 overflow-x-auto [scrollbar-width:thin]">
        <table className="border-separate border-spacing-x-1.5 text-center tabular-nums">
          <thead>
            <tr className="text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
              <th scope="col" className="sticky left-0 bg-[var(--color-surface)]">
                <span className="sr-only">時刻</span>
              </th>
              {hours.map((hour, index) => (
                <th key={today.times[index]} scope="col" className="font-normal">
                  {hour}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <RowHead name="気温（℃）">
                <ThermometerIcon size={14} />
              </RowHead>
              {today.temperature_c.map((value, index) => (
                <td key={today.times[index]}>{decimal(value)}</td>
              ))}
            </tr>
            <tr>
              <RowHead name="降水量（mm）">
                <RaindropIcon size={14} />
              </RowHead>
              {today.precipitation_mm.map((value, index) => (
                <td key={today.times[index]}>{precipitation(value)}</td>
              ))}
            </tr>
            <tr>
              <RowHead name="風速（m/s）">
                <WindIcon size={14} />
              </RowHead>
              {today.wind_speed_ms.map((value, index) => {
                const from = today.wind_direction_deg[index];
                return (
                  <td key={today.times[index]} className="whitespace-nowrap">
                    {from != null && (
                      <span
                        className="inline-flex align-[-2px]"
                        style={{ transform: `rotate(${downwindOnMapDeg(from, mapBearingDeg)}deg)` }}
                      >
                        <WindDirectionArrowIcon size={12} />
                      </span>
                    )}
                    {decimal(value)}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
      <p className={cn(textVariants({ variant: "note" }), "mt-1")}>{mapDisplay.modelValueDisclaimer}</p>
    </section>
  );
}
