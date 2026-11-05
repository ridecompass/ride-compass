"use client";

import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { textVariants } from "@/components/ui/Text/Text";
import PenaltyBreakdown from "@/features/route/PenaltyBreakdown/PenaltyBreakdown";
import WarningText from "@/features/route/WarningText/WarningText";
import { formatDurationShort } from "@/lib/duration";
import { formatLensNumber } from "@/lib/mapDisplay/costLensPaint";
import { formatPenalty, type PenaltyCatalog } from "@/lib/routePenalty";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import type { PenaltyBreakdown as PenaltyValues, RouteFacts } from "@/types/route";

/** 区間ごとに速度を変える条件の名前（backendの走行モデルが宣言する並び）。 */
const SPEED_CONDITIONS = routeGenerateConfig.segment_speed_conditions.join("・");

interface RouteAxisProfileProps {
  /** RouteCandidate.penalty（軸ごとと回避指定の代償の秒）。 */
  penalty: PenaltyValues;
  /** RouteCandidate.facts（軸ごとの事実の量と、標高の無い長さ）。 */
  facts: RouteFacts;
  /** 費用の軸の一覧（行の名前と色）。 */
  catalog: PenaltyCatalog;
  /** RouteCandidate.estimated_duration_seconds（走行＋停止＋ターンの見積もり）。 */
  estimatedDurationSeconds: number | null;
  /** 所要時間を、風の値を使えず無風として出した（RouteCandidate.wind_unavailable）。 */
  windUnavailable: boolean;
  /** 所要時間を、勾配か停止要因の値が無く平地・待ち無しとして出した区間の距離の割合（0〜1、
   * RouteCandidate.missing_travel_data_share）。 */
  missingTravelDataShare: number | null;
}

/** ルート結果の所要時間と負担（読むだけ）。負担は、避けたいもの（登り・止まる回数・振動等の軸）を通る代償を秒にしたもので、
 * 軸ごとの内訳を帯と一覧で出し、軸ごとの事実の量を添える。レンズはここでは選ばない（入口は地図の上のピルだけ）。 */
export default function RouteAxisProfile({
  penalty,
  facts,
  catalog,
  estimatedDurationSeconds,
  windUnavailable,
  missingTravelDataShare,
}: RouteAxisProfileProps) {
  // 値の無い区間の割合（丸めた%）。値が無ければ0として扱い、知らせない。
  const missingPct = missingTravelDataShare == null ? 0 : Math.round(missingTravelDataShare * 100);

  return (
    <div className="mx-0.5 mt-0.5 mb-1 flex flex-col gap-1">
      {/* 数値の行と内訳の帯を分ける——同じ折り返しの行へ入れると、数値の文字数で帯が数値の横へ入るか次の行へ落ちるかが
          変わり、候補ごとに帯の長さが揃わない。 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        {estimatedDurationSeconds != null && (
          <span className="inline-flex flex-shrink-0 items-baseline gap-0.5">
            <span className={textVariants({ variant: "hint" })}>所要</span>
            <span className="text-[1.05rem] font-semibold">{formatDurationShort(estimatedDurationSeconds)}</span>
            <InfoPopover triggerAriaLabel="所要時間の説明">
              <p>
                {`走行時間[${SPEED_CONDITIONS}と想定した巡航速度から区間ごとに計算]に、`}
                信号などで止まる待ちと、交差点で曲がる待ちを足した見積もりです。実際の信号のタイミングや走り方で変わります。
              </p>
            </InfoPopover>
          </span>
        )}
        <span className="inline-flex flex-shrink-0 items-baseline gap-0.5">
          <span className={textVariants({ variant: "hint" })}>負担</span>
          <span className="text-[1.05rem] font-semibold">{formatPenalty(penalty.total_seconds)}</span>
          <InfoPopover triggerAriaLabel="負担の説明">
            <p>
              登り・止まる回数・路面の振動など、避けたいものを通る分を、所要時間に上乗せした時間として数えたものです。
              最速の1本を比べる基準として先頭に置き、残りは所要時間と負担の和が小さい順に並びます（周回は1kmあたり）。下の一覧は負担を軸ごとに分けたものです。
            </p>
          </InfoPopover>
        </span>
      </div>
      {/* 所要時間の前提が崩れていることは、所要時間のすぐ下で知らせる（黙って短い所要時間を見せない）。
          値の無い区間は丸めて1%以上のときだけ出す——0%を並べても判断の材料にならない。 */}
      {windUnavailable && <WarningText>{routeGenerateConfig.missing_wind_wording}</WarningText>}
      {missingPct >= 1 && (
        <WarningText>{`データの無い区間が${missingPct}%[${routeGenerateConfig.missing_travel_data_wording}]`}</WarningText>
      )}
      <PenaltyBreakdown penalty={penalty} facts={facts.axes} catalog={catalog} />
      {facts.elevation_unknown_km > 0 && (
        <p className={textVariants({ variant: "hint" })}>
          {`標高の無い道 ${formatLensNumber(facts.elevation_unknown_km)}km（登りに数えていません）`}
        </p>
      )}
    </div>
  );
}
