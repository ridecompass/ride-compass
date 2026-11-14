"use client";

import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { textVariants } from "@/components/ui/Text/Text";
import WarningText from "@/features/route/WarningText/WarningText";
import { formatDurationShort } from "@/lib/duration";
import { formatPenalty } from "@/lib/routePenalty";
import { ROAD_SETTINGS_TAB_NAME } from "@/lib/screenNames";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import type { PenaltyBreakdown as PenaltyValues } from "@/types/route";

/** 区間ごとに速度を変える条件の名前（backendの走行モデルが宣言する並び）。 */
const SPEED_CONDITIONS = routeGenerateConfig.segment_speed_conditions.join("・");

interface RouteAxisProfileProps {
  /** RouteCandidate.penalty（軸ごとの代償の秒と、好む道・避ける道で増減した秒）。 */
  penalty: PenaltyValues;
  /** RouteCandidate.estimated_duration_seconds（走行＋停止＋ターンの見積もり）。 */
  estimatedDurationSeconds: number | null;
  /** 所要時間を、勾配か停止要因の値が無く全体の平均で出した区間の距離の割合（0〜1、
   * RouteCandidate.missing_travel_data_share）。 */
  missingTravelDataShare: number | null;
}

/** ルート結果の所要時間と負担（読むだけ）。負担は、避けたいもの（登り・止まる回数・振動等の軸）を通る代償を秒にしたもので、
 * 種類ごとの内訳と事実は道のりのグラフの右上の一覧が出す。レンズはここでは選ばない（入口は地図の上のピルだけ）。 */
export default function RouteAxisProfile({
  penalty,
  estimatedDurationSeconds,
  missingTravelDataShare,
}: RouteAxisProfileProps) {
  // 値の無い区間の割合（丸めた%）。値が無ければ0として扱い、知らせない。
  const missingPct = missingTravelDataShare == null ? 0 : Math.round(missingTravelDataShare * 100);

  return (
    <div className="mx-0.5 mt-0.5 mb-1 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        {estimatedDurationSeconds != null && (
          <span className="inline-flex flex-shrink-0 items-baseline gap-0.5">
            <span className={textVariants({ variant: "hint" })}>所要</span>
            <span className="text-[1.05rem] font-semibold">{formatDurationShort(estimatedDurationSeconds)}</span>
            <InfoPopover triggerAriaLabel="所要時間の説明">
              <p>
                {"区間ごとの走行時間に、信号などで止まる時間と、交差点を曲がるのにかかる時間を足した見積もりです。" +
                  `走行時間は、想定した巡航速度と${SPEED_CONDITIONS}から計算します。実際の信号のタイミングや走り方で変わります。`}
              </p>
            </InfoPopover>
          </span>
        )}
        <span className="inline-flex flex-shrink-0 items-baseline gap-0.5">
          <span className={textVariants({ variant: "hint" })}>負担</span>
          <span className="text-[1.05rem] font-semibold">{formatPenalty(penalty.total_seconds)}</span>
          <InfoPopover triggerAriaLabel="負担の説明">
            <p>
              {"登り・止まる回数・路面の振動など、避けたいものを通る分を時間に直し、所要時間に上乗せしたものです。" +
                "候補は、最速の1本を比べる基準として先頭に置き、残りを所要時間と負担の和が小さい順に並べます[周回は1kmあたりの負担で比べます]。" +
                "グラフの右上の一覧は、負担を種類ごとに分けたものです[曲がる所の漕ぎ出しは、止まってから漕ぎ出す負担に入れます]。" +
                `${ROAD_SETTINGS_TAB_NAME}のタブで好むとした道を通って減った分[−]と、避けるとした道を通って増えた分も、` +
                "この負担に入ります。その区間は、地図のルートの線の両脇の線で示します。"}
            </p>
          </InfoPopover>
        </span>
      </div>
      {/* 所要時間の前提が崩れていることは、所要時間のすぐ下で知らせる（黙って短い所要時間を見せない）。
          値の無い区間は丸めて1%以上のときだけ出す——0%を並べても判断の材料にならない。 */}
      {missingPct >= 1 && (
        <WarningText>{`データの無い区間が${missingPct}%[${routeGenerateConfig.missing_travel_data_wording}]`}</WarningText>
      )}
    </div>
  );
}
