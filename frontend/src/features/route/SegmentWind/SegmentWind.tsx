import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { WindDirectionArrowIcon } from "@/components/ui/icons/lucideIcons";
import { cardinalLabel, downwindDeg } from "@/lib/cardinalLabel";
import { formatJstHourMinute, parseJstLocalValue } from "@/lib/time";
import { mapDisplay } from "@/types/generated/mapDisplay";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import type { RouteSegmentDetail } from "@/types/route";

const HOURS_PER_LEG = routeGenerateConfig.wind_forecast_hours_per_leg;
const HOURS_PER_BIN = routeGenerateConfig.wind_time_bin_hours;

type Wind = NonNullable<RouteSegmentDetail["wind"]>;

// どの時刻の値を使ったかを出す——出さないと、ヘッダーの風（今の観測）と見比べて食い違って見える。値は数値予報モデルの
// 最寄りの格子点の値で、「その区間の予報」として示さない（docs/architecture/data-sources.md「気象業務法の予報業務許可」節）。
function windTimeLabel(wind: Wind): string {
  return `最寄りの格子点の${formatJstHourMinute(parseJstLocalValue(wind.forecast_at))}の計算値`;
}

function windValueLabel(wind: Wind): string {
  return `${cardinalLabel(wind.direction_deg)} ${wind.speed_ms.toFixed(1)}m/s`;
}

function WindExplanation() {
  return (
    <p>
      この区間を通る見込みの時刻の、区間の中ほどに最寄りの格子点の風[気象庁の数値予報モデルMSMの格子点の値をそのまま、
      {HOURS_PER_BIN}時間刻み]で評価しています。 {mapDisplay.modelValueDisclaimer}往路・復路それぞれ、走り始めてから
      {HOURS_PER_LEG}
      時間先までの区間に出します。
    </p>
  );
}

/** 区間の評価に使った風のチップ。風が吹いていく向きの矢印と風向風速を出し、押すと使った時刻と説明を開く。 */
export function SegmentWindChip({ wind, className }: { wind: RouteSegmentDetail["wind"]; className: string }) {
  if (wind == null) return null;
  return (
    <InfoPopover
      triggerClassName={className}
      triggerAriaLabel={`区間の風（最寄りの格子点の値 ${windValueLabel(wind)}）の説明`}
      triggerContent={
        <>
          <span
            aria-hidden="true"
            className="inline-flex"
            style={{ transform: `rotate(${downwindDeg(wind.direction_deg)}deg)` }}
          >
            <WindDirectionArrowIcon size={14} />
          </span>
          <span>{windValueLabel(wind)}</span>
        </>
      }
    >
      <p className="font-medium">{windTimeLabel(wind)}</p>
      <WindExplanation />
    </InfoPopover>
  );
}
