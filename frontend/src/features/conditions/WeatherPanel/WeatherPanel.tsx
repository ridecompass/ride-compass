"use client";

import { Fragment, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover/Popover";
import {
  NotFetchedIcon,
  RaindropIcon,
  ThermometerIcon,
  WindDirectionArrowIcon,
} from "@/components/ui/icons/lucideIcons";
import { Button } from "@/components/ui/Button/Button";
import { formatJstHourMinute } from "@/lib/time";
import { downwindOnMapDeg } from "@/lib/cardinalLabel";
import { cn } from "@/lib/cn";
import type { AmedasObservation, GridPointToday as GridPointTodayValues } from "@/types/weather";
import { getAmedasWeatherDisplay } from "./amedasWeatherIcon";
import GridPointToday from "./GridPointToday";
import { textVariants } from "@/components/ui/Text/Text";

interface WeatherPanelProps {
  amedas: AmedasObservation | null;
  error: string | null;
  /** 最寄りの格子点の今日の値と、その取得の失敗。押すと開くパネルの中にだけ出す。 */
  today: GridPointTodayValues | null;
  todayError: string | null;
  /** 地図の向き（地図の上が真北から時計回りに何度か）。風の矢印をこの分だけ戻し、地図の上の向きに合わせる。 */
  mapBearingDeg: number;
}

// 常設ヘッダーのバーは数値予報モデルの計算値ではなく最寄りアメダス観測所の実測値のみで構成する。モデルの値は、押すと開く
// パネルの中に最寄りの格子点の値として出す。
//
// アメダスは観測専用APIのため、降水確率・天気は含まれない。代わりに:
// - 降水確率 → 実測の10分間降水量（precipitation_10min_mm）
// - 天気アイコン → backendが10分間降水量・気温と、地点の推計気象分布（気象庁の実況）の晴れ・くもりから
//   導いた天気コード（weather_code）
// - 突風 → アメダスの速報値レスポンスに突風フィールドが存在しないため非表示
//
// 日の出/日没は1日1個の値のため、バーには並べず、押すと開くパネルにだけ出す——バーは走行中に何度も見る瞬間値だけに
// 絞る。日の出/日没は観測ではなく地点の天文計算の値なので、観測の表とは分けて置く。
//
// 観測であること・観測所名・観測の時刻と、数値ごとの意味は、バーを押すと開くパネルに出す。390pxの幅ではヘッダーに
// 足す余地が無く、バーへ並べると右の警報のバッジが画面の外へ押し出される。
/** 日の出・日没の時刻（JST）。壊れた値は「--:--」にして行ごと落とさない。 */
function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  return formatJstHourMinute(date);
}

function isCurrentlyDay(twilight: AmedasObservation["twilight"]): boolean {
  if (twilight === null) return true;
  const now = Date.now();
  return now >= new Date(twilight.sunrise).getTime() && now < new Date(twilight.sunset).getTime();
}

/** ヘッダーの統計チップ1つ（アイコン+数値）。 */
function Stat({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap text-[length:var(--font-size-md)] font-semibold">
      {children}
    </span>
  );
}

/** 数値と単位。1つのspanにまとめてチップのgapが間に入らないようにする（flexboxのgapは直接の子要素すべての間に
 * 均等に効くため、別々の子要素のままにすると、アイコン↔数値と同じ間隔が数値↔単位にも入る）。 */
function Value({ unit, children }: { unit: string; children: ReactNode }) {
  return (
    <span>
      {children}
      <span className="text-[0.8em] font-normal text-[var(--color-muted)]">{unit}</span>
    </span>
  );
}

function Divider() {
  return <span className="w-px flex-shrink-0 self-stretch bg-[var(--color-border)]" aria-hidden="true" />;
}

export default function WeatherPanel({ amedas, error, today, todayError, mapBearingDeg }: WeatherPanelProps) {
  // 手元に観測値があるなら、直近の取り直しが失敗していてもそちらを出す（失敗の文言で
  // 値を置き換えない）。取得は一定間隔で続くため、回復すれば表示も戻る。
  if (!amedas) {
    // 値も失敗もまだ無い間（最初の読み込み中）は、何も出さずに値を待つ（上部の帯には値とアイコンだけを置く）。
    // 失敗のあとの取り直しの間は失敗の印を出したままにする（取り直しのたびに消すと、回復したように見えて点滅する）。
    // backendは観測所の解決失敗・欠測・上流の取得失敗を区別せず502にするため、「無い」と
    // 断定せず取得できなかったことだけを印で出す。原因の詳細（混雑・HTTPステータス等）は使い方の文へ回す。
    if (error)
      return (
        <span
          role="img"
          aria-label="観測値を取得できません"
          data-usage={`いまいる場所の観測値を取れていません（${error}）。取り直しは続いていて、取れればここに値が出ます。`}
          className="inline-flex size-7 items-center justify-center text-[var(--color-danger)]"
        >
          <NotFetchedIcon size={18} />
        </span>
      );
    return null;
  }

  const temperature = amedas.temperature_c != null ? amedas.temperature_c.toFixed(1) : "-";
  const wind =
    amedas.wind_speed_ms != null && amedas.wind_direction !== null
      ? { speedMs: amedas.wind_speed_ms, direction: amedas.wind_direction }
      : null;

  const weatherDisplay = getAmedasWeatherDisplay(amedas.weather_code, isCurrentlyDay(amedas.twilight));

  const items: { term: string; value: string; stat: ReactNode }[] = [
    {
      term: "気温",
      value:
        `${temperature}℃` +
        (amedas.apparent_temperature_c != null ? `（体感 ${amedas.apparent_temperature_c.toFixed(1)}℃）` : ""),
      stat: (
        <>
          <ThermometerIcon size={16} />
          <span className="sr-only">気温: </span>
          <Value unit="℃">{temperature}</Value>
        </>
      ),
    },
    ...(wind
      ? [
          {
            term: "風",
            value: `${wind.direction.label}の風 ${wind.speedMs.toFixed(1)}m/s`,
            stat: (
              <>
                <span
                  className="inline-flex transition-transform duration-200"
                  style={{ transform: `rotate(${downwindOnMapDeg(wind.direction.deg, mapBearingDeg)}deg)` }}
                >
                  <WindDirectionArrowIcon size={16} />
                </span>
                <span className="sr-only">{wind.direction.label}の風: </span>
                <Value unit="m/s">{wind.speedMs.toFixed(1)}</Value>
              </>
            ),
          },
        ]
      : []),
    ...(amedas.precipitation_10min_mm != null
      ? [
          {
            term: "降水量",
            value: `${amedas.precipitation_10min_mm.toFixed(1)}mm（直近10分間）`,
            stat: (
              <>
                <RaindropIcon size={16} />
                <span className="sr-only">降水量: </span>
                <Value unit="mm">{amedas.precipitation_10min_mm.toFixed(1)}</Value>
              </>
            ),
          },
        ]
      : []),
    ...(weatherDisplay != null
      ? [
          {
            term: "天気",
            value: weatherDisplay.label,
            stat: (
              <>
                <weatherDisplay.Icon size={16} />
                <span className="sr-only">天気: {weatherDisplay.label}</span>
              </>
            ),
          },
        ]
      : []),
  ];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="bare"
          className="min-w-0 rounded-sm"
          usage="ヘッダーの天気がどの観測所のいつの観測かを開きます。"
        >
          {/* 気温・風向風速・降水量・天気アイコンをアイコン+数値だけの統計チップとして1行に並べる
              （はみ出した分は横へ流し、ヘッダーを2行にしない）。ボタンの中に置くのでdivでなくspan。 */}
          <span className="flex flex-nowrap items-center gap-2 overflow-x-auto text-[var(--foreground)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {items.map(({ term, stat }, index) => (
              <Fragment key={term}>
                {index > 0 && <Divider />}
                <Stat>{stat}</Stat>
              </Fragment>
            ))}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent layer="header" className="w-72 max-w-[calc(100vw-2*var(--space-3))]" side="bottom" align="start">
        <p className={cn(textVariants({ variant: "note" }), "font-bold tracking-wide")}>アメダスの観測</p>
        <p className="text-[length:var(--font-size-md)] font-semibold">
          {amedas.station_name}
          <span className="ml-2 tabular-nums">{formatJstHourMinute(new Date(amedas.observed_at))}</span>
        </p>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-[length:var(--font-size-sm)]">
          {items.map(({ term, value }) => (
            <div key={term} className="contents">
              <dt className="text-[var(--color-muted)]">{term}</dt>
              <dd className="m-0 tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <p className={cn(textVariants({ variant: "note" }), "mt-1")}>最寄りの観測所で測った値です。</p>
        {amedas.twilight !== null && (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 border-t border-[var(--color-border)] pt-2 text-[length:var(--font-size-sm)]">
            <dt className="text-[var(--color-muted)]">日の出・日没</dt>
            <dd className="m-0 tabular-nums">
              {formatClockTime(amedas.twilight.sunrise)}〜{formatClockTime(amedas.twilight.sunset)}
            </dd>
          </dl>
        )}
        <GridPointToday today={today} error={todayError} mapBearingDeg={mapBearingDeg} />
      </PopoverContent>
    </Popover>
  );
}
