import { Dot } from "@/components/ui/Dot/Dot";
import { textVariants } from "@/components/ui/Text/Text";
import { useClientConfig } from "@/hooks/useClientConfig";
import { cn } from "@/lib/cn";
import { formatAlongDistance } from "@/lib/geoDistance";
import { paintedStretches } from "@/lib/roadAvoidance";
import { formatPenalty } from "@/lib/routePenalty";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import type { RoadAvoidanceOverride, RouteSegmentDetail } from "@/types/route";

const RAIL = mapDisplay.avoidanceRail;
const MARK_WIDTH_PX = 22;

/** 地図のルートの両脇の線と同じ色・刻みの短い線。 */
function RailMark({ color, dashed }: { color: string; dashed: boolean }) {
  const stroke = RAIL.widthPx + 1;
  return (
    <svg aria-hidden="true" width={MARK_WIDTH_PX} height={stroke} className="flex-none">
      <line
        x1={0}
        y1={stroke / 2}
        x2={MARK_WIDTH_PX}
        y2={stroke / 2}
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={dashed ? RAIL.avoidedDash.map((length) => length * stroke).join(" ") : undefined}
      />
    </svg>
  );
}

/**
 * 区間の小窓の、地図のルートの両脇の線（避ける・好むにした道を通る区間）の理由: 線と同じ印・増えた（減った）秒と、その区間が通る
 * 段の付いた道の区分の名前・長さ・段。スマホの幅に収まるよう、1行を短くし、区分は字を小さくして折り返す。
 */
export default function RailReason({
  segment,
  applied,
}: {
  segment: RouteSegmentDetail;
  /** 生成に使った避け方（応答の条件）。無ければ区分を出さない。 */
  applied: RoadAvoidanceOverride | null;
}) {
  const avoidance = useClientConfig().roadClasses.avoidance;
  const rails = [
    {
      name: "避ける道",
      color: palette.semantic.avoidance_avoided,
      dashed: true,
      seconds: segment.penalty.avoided_seconds,
    },
    {
      name: "好む道",
      color: palette.semantic.avoidance_preferred,
      dashed: false,
      seconds: segment.penalty.preferred_seconds,
    },
  ].filter((rail) => rail.seconds !== 0);
  if (rails.length === 0) return null;
  const stretches = applied === null ? [] : paintedStretches(segment.road_classes, applied, avoidance);
  return (
    <div role="group" aria-label="ルートの脇の線の理由" className="flex flex-col gap-0.5">
      {rails.map((rail) => (
        <span key={rail.name} className="flex items-center gap-1.5">
          <RailMark color={rail.color} dashed={rail.dashed} />
          <span>{rail.name}</span>
          <span className="ml-auto pl-2 font-semibold">{formatPenalty(rail.seconds)}</span>
        </span>
      ))}
      {stretches.length > 0 && (
        <ul className={cn(textVariants({ variant: "hint" }), "m-0 flex list-none flex-col p-0")}>
          {stretches.map(({ section, row, level, km }) => (
            <li key={row.key} className="flex flex-wrap items-baseline gap-x-1">
              <Dot tone="none" style={{ backgroundColor: level.color }} />
              <span>{section}</span>
              <span className="text-[var(--foreground)]">{row.label}</span>
              <span>{formatAlongDistance(km * 1000)}</span>
              <span>{level.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
