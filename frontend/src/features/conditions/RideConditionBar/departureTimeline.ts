// 出発時刻ピッカー（RideConditionBar）のドラッグタイムライン用の目盛り生成。気象レイヤーの
// 取得結果に依存しない理由と刻みの粒度はdocs/modules/frontend/dynamic-weather-layers.md
// 「共有タイムラインのラベル」節が持つ。
import { HOUR_MS } from "@/lib/duration";
import { formatJstDateTime, formatJstHourMinute, formatJstMinute, jstParts } from "@/lib/time";
import type { RulerFrame } from "@/components/ui/Ruler/Ruler";
import { DEPARTURE_STEP_MS, floorToDepartureStep } from "@/features/conditions/rideConditions";
import { mapDisplay } from "@/types/generated/mapDisplay";

/** 目盛りの刻み。5分刻みは直近だけを、1時間刻みはMSMの予報を読む先までを並べる。 */
export type DepartureStep = "5min" | "hour";

export const DEPARTURE_STEPS: readonly { value: DepartureStep; label: string }[] = [
  { value: "5min", label: "5分" },
  { value: "hour", label: "1時間" },
];

export function isDepartureStep(value: string): value is DepartureStep {
  return DEPARTURE_STEPS.some((step) => step.value === value);
}

const FINE_WINDOW_MS = HOUR_MS;
// 出発時刻を選べる先は、MSMの予報を読む先まで。
const HORIZON_MS = mapDisplay.weather.msmForecastHours * HOUR_MS;

/** anchor（ポップオーバーを開いた時点の時刻）を5分刻みへ切り下げた「今」を先頭にした目盛りを生成する。
 * 5分刻みは「今」から60分先までを5分ずつ、1時間刻みは「今」の後の正時だけをMSMの予報を読む先まで並べる。 */
export function buildDepartureTimeline(anchor: Date, step: DepartureStep): Date[] {
  const nowMs = floorToDepartureStep(anchor.getTime());
  const times: Date[] = [new Date(nowMs)];
  if (step === "5min") {
    for (let t = nowMs + DEPARTURE_STEP_MS; t <= nowMs + FINE_WINDOW_MS; t += DEPARTURE_STEP_MS) {
      times.push(new Date(t));
    }
    return times;
  }
  const horizonMs = anchor.getTime() + HORIZON_MS;
  for (let t = Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS; t <= horizonMs; t += HOUR_MS) {
    times.push(new Date(t));
  }
  return times;
}

/** DynamicLayerTimeSlider向けのラベル列。コマの幅は刻みの中で揃える（ルーラーは大きい目盛りのコマを広げるので、
 * 1時間刻みは全部を大きい目盛りに、5分刻みは全部を小さい目盛りにする）。5分刻みの目盛りには分を、
 * 正時には時刻を書き、1時間刻みは日本時間の偶数時だけ時刻を書く。 */
export function buildDepartureFrames(timeline: readonly Date[], step: DepartureStep): RulerFrame[] {
  return timeline.map((time) => {
    const { hour, minute } = jstParts(time);
    const isHour = minute === 0;
    return {
      label: formatJstDateTime(time),
      major: step === "hour",
      tickLabel:
        step === "5min"
          ? isHour
            ? formatJstHourMinute(time)
            : formatJstMinute(time)
          : isHour && hour % 2 === 0
            ? formatJstHourMinute(time)
            : undefined,
    };
  });
}
