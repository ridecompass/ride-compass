import { textVariants } from "@/components/ui/Text/Text";
import { useClientConfig } from "@/hooks/useClientConfig";
import { formatAlongDistance } from "@/lib/geoDistance";
import { formatPenalty } from "@/lib/routePenalty";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import type { RouteSegmentDetail } from "@/types/route";

const RAIL = mapDisplay.avoidanceRail;
const MARK_WIDTH_PX = 22;

/** 地図のルートの両脇の線と同じ色・刻みの短い線（避ける道は点線、好む道は実線）。 */
function RailMark({ avoided }: { avoided: boolean }) {
  const stroke = RAIL.widthPx + 1;
  return (
    <svg aria-hidden="true" width={MARK_WIDTH_PX} height={stroke} className="flex-none self-center">
      <line
        x1={0}
        y1={stroke / 2}
        x2={MARK_WIDTH_PX}
        y2={stroke / 2}
        stroke={avoided ? palette.semantic.avoidance_avoided : palette.semantic.avoidance_preferred}
        strokeWidth={stroke}
        strokeDasharray={avoided ? RAIL.avoidedDash.map((length) => length * stroke).join(" ") : undefined}
      />
    </svg>
  );
}

/**
 * 区間の小窓の、地図のルートの両脇の線（避ける・好むにした道を通る区間）の理由: 避け方の倍率が秒を足し引きした道を、倍率を決めた
 * 行ごとに（応答の`avoidance_stretches`）。行・まとまり・段の名前は道路タブと同じ画面の設定から引く。スマホの幅に収まるよう、
 * 1つの道を2行（線の印・道の名前・秒と、小さい字のまとまり・長さ・段）にする。
 */
export default function RailReason({ segment }: { segment: RouteSegmentDetail }) {
  const { rows, sections, levels } = useClientConfig().roadClasses.avoidance;
  if (segment.avoidance_stretches.length === 0) return null;
  return (
    <ul aria-label="ルートの脇の線の理由" className="m-0 flex list-none flex-col gap-1 p-0">
      {segment.avoidance_stretches.map((stretch) => {
        const row = rows.find((candidate) => candidate.key === stretch.row_key);
        const section = sections.find((candidate) => candidate.key === row?.section);
        const level = levels.find((candidate) => candidate.key === stretch.level);
        return (
          <li key={stretch.row_key} className="flex flex-col">
            <span className="flex items-center gap-1.5">
              <RailMark avoided={stretch.seconds > 0} />
              <span>{row?.label ?? stretch.row_key}</span>
              <span className="ml-auto pl-2 font-semibold">{formatPenalty(stretch.seconds)}</span>
            </span>
            <span className={textVariants({ variant: "hint" })} style={{ paddingLeft: MARK_WIDTH_PX + 6 }}>
              {[section?.label, formatAlongDistance(stretch.distance_km * 1000), level?.label]
                .filter(Boolean)
                .join("・")}
            </span>
          </li>
        );
      })}
      {segment.regulation_margin && (
        // ルートは通る見込みの時間帯を前後に広げて交通規制を見込むので、地図（出発の時刻そのもので塗る）では規制の外に見える道もある。
        <li className={textVariants({ variant: "hint" })}>規制の時間帯の近くを通るため、時間で変わる交通規制が効くとみなしました</li>
      )}
    </ul>
  );
}
