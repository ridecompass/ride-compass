import { pinMarkName } from "@/components/PinMark/PinMark";
import PointMark from "@/components/PinMark/PointMark";
import { cn } from "@/lib/cn";
import { formatJstHourMinute } from "@/lib/time";
import { mapDisplay } from "@/types/generated/mapDisplay";

import { PROFILE_VIEW_HEIGHT, PROFILE_VIEW_WIDTH, profileTextClass } from "./profileScale";

/** 置いた経由地を通る所のルートの上の距離と、そこへ着く見込みの時刻（計画の時刻が欠けていればnull）。 */
export type ProfileWaypoint = { readonly km: number; readonly arrivalAt: Date | null };

/** 図の上に重ねる札の地（下の絵が透けて見え、文字が読める）。 */
const LABEL_CLASS =
  "rounded-sm bg-[color-mix(in_srgb,var(--color-surface-2)_75%,transparent)] px-0.5 text-[var(--foreground)] tabular-nums";

/** 縦の値の目盛り（0〜`PROFILE_VIEW_HEIGHT`の縦の位置と文字）。 */
export type ValueTick = { readonly y: number; readonly label: string };

interface ProfileMarksProps {
  /** 距離を描画の横座標へ。 */
  xOf: (km: number) => number;
  /** 横軸の右端の距離。 */
  widthKm: number;
  waypoints: readonly ProfileWaypoint[];
  /** 走行中の現在地の距離（ルートの長さの中へ寄せたもの）。走行中でなければnull。 */
  travelledKm: number | null;
  progressMarkY: number | null;
  valueTicks: readonly ValueTick[];
  riding: boolean;
}

/** 道のりの図の上に重ねる印と文字（経由地の番号・現在地の丸・値の目盛り・距離の目盛り）。図の絵（SVG）は横へ伸ばして
 * 描くので、形の崩れる印と文字は図の上へ重ねた要素で出す。 */
export default function ProfileMarks({
  xOf,
  widthKm,
  waypoints,
  travelledKm,
  progressMarkY,
  valueTicks,
  riding,
}: ProfileMarksProps) {
  return (
    <>
      {waypoints.map(({ km, arrivalAt }, index) => {
        const travelled = travelledKm !== null && km <= travelledKm;
        // 走り終えた経由地には時刻を添えない（見込みの時刻で、通った時刻ではない）。
        const arrival = arrivalAt === null || travelled ? null : `${formatJstHourMinute(arrivalAt)}着`;
        return (
          <span
            key={index}
            role="img"
            aria-label={`${pinMarkName("waypoint", String(index + 1))}（${km.toFixed(1)}km地点${arrival === null ? "" : `・${arrival}`}）`}
            className="pointer-events-none absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
            style={{
              left: `${(xOf(km) / PROFILE_VIEW_WIDTH) * 100}%`,
              opacity: travelled ? mapDisplay.route.opacities.travelled : undefined,
            }}
          >
            <PointMark role="waypoint" label={String(index + 1)} originLocated={false} />
            {/* 時刻は印の下へ重ね、印の中心を経由地の線の上に保つ。 */}
            {arrival !== null && (
              <span
                aria-hidden="true"
                className={cn("absolute top-full mt-0.5 whitespace-nowrap", LABEL_CLASS, profileTextClass(riding))}
              >
                {arrival}
              </span>
            )}
          </span>
        );
      })}
      {travelledKm !== null && (
        <span
          role="img"
          aria-label="現在地"
          data-progress="mark"
          className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white bg-[var(--color-accent)] shadow"
          style={{
            left: `${(xOf(travelledKm) / PROFILE_VIEW_WIDTH) * 100}%`,
            top: `${((progressMarkY ?? PROFILE_VIEW_HEIGHT / 2) / PROFILE_VIEW_HEIGHT) * 100}%`,
          }}
        />
      )}
      {valueTicks.map((tick) => (
        <span
          key={tick.label}
          className={cn(
            "pointer-events-none absolute left-1 -translate-y-1/2",
            LABEL_CLASS,
            profileTextClass(riding),
          )}
          style={{ top: `${(tick.y / PROFILE_VIEW_HEIGHT) * 100}%` }}
        >
          {tick.label}
        </span>
      ))}
      <div className="pointer-events-none absolute inset-x-1 bottom-0 flex justify-between text-[var(--color-muted)] tabular-nums">
        <span className={profileTextClass(riding)}>0</span>
        <span className={profileTextClass(riding)}>{widthKm.toFixed(1)}km</span>
      </div>
    </>
  );
}
