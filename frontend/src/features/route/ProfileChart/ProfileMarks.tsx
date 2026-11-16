import { Fragment, useRef, useState, type CSSProperties } from "react";

import { pinMarkName } from "@/components/PinMark/PinMark";
import PointMark from "@/components/PinMark/PointMark";
import { useIsomorphicLayoutEffect } from "@/hooks/useIsomorphicLayoutEffect";
import { cn } from "@/lib/cn";
import { formatJstHourMinute } from "@/lib/time";
import { mapDisplay } from "@/types/generated/mapDisplay";

import { placeArrivalLabels, type Box, type LabelShift } from "./arrivalLabels";
import { PROFILE_VIEW_HEIGHT, PROFILE_VIEW_WIDTH, profileTextClass } from "./profileScale";

/** 置いた経由地を通る所のルートの上の距離と、そこへ着く見込みの時刻（計画の時刻が欠けていればnull）。 */
export type ProfileWaypoint = { readonly km: number; readonly arrivalAt: Date | null };

/** 図の上に重ねる札の地（下の絵が透けて見え、文字が読める）。 */
const LABEL_CLASS =
  "rounded-sm bg-[color-mix(in_srgb,var(--color-surface-2)_75%,transparent)] px-0.5 text-[var(--foreground)] tabular-nums";

/** 経由地の印の径（px）。着く時刻の札はその下に置く。 */
const WAYPOINT_MARK_PX = 18;

/** 現在地の丸の径（px）。 */
const PROGRESS_MARK_PX = 16;

/** 中心を変数`--at`の横の位置に置く印。端の地点でも印が図の縁を越えないよう、中心を図の内側へ半径（変数`--radius`）まで寄せる。 */
const INSIDE_CHART_CLASS = "left-[clamp(var(--radius),var(--at),calc(100%_-_var(--radius)))]";

/** `INSIDE_CHART_CLASS`の印を、径`sizePx`で横の位置`at`に置く変数。 */
const insideChart = (at: string, sizePx: number) =>
  ({ "--at": at, "--radius": `${sizePx / 2}px`, width: sizePx, height: sizePx }) as CSSProperties;

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
  const arrivals = waypoints.map(({ km, arrivalAt }) =>
    // 走り終えた経由地には時刻を添えない（見込みの時刻で、通った時刻ではない）。
    arrivalAt === null || (travelledKm !== null && km <= travelledKm) ? null : `${formatJstHourMinute(arrivalAt)}着`,
  );
  const axisRef = useRef<HTMLDivElement>(null);
  // 札の大きさは文字と文字の大きさで決まり、描いてからでないと分からないので、描いたあとに測って置き直す。
  const [shifts, setShifts] = useState<readonly LabelShift[]>([]);
  const layoutKey = `${widthKm}|${riding}|${waypoints.map(({ km }, index) => `${km}:${arrivals[index]}`).join(",")}`;
  useIsomorphicLayoutEffect(() => {
    const chart = axisRef.current?.parentElement;
    if (!chart) return;
    const place = () => {
      const origin = chart.getBoundingClientRect();
      const relative = (rect: DOMRect): Box => ({
        left: rect.left - origin.left,
        right: rect.right - origin.left,
        top: rect.top - origin.top,
        bottom: rect.bottom - origin.top,
      });
      // 札は図の上に直に置くので、offsetLeft・offsetTop は図の中の動かす前の位置（transform を数えない）。
      const labels = [...chart.querySelectorAll<HTMLElement>("[data-arrival-label]")];
      const spots = labels.map((label) => ({
        centerX: label.offsetLeft,
        top: label.offsetTop,
        width: label.offsetWidth,
        height: label.offsetHeight,
      }));
      const obstacles = [...chart.querySelectorAll("[data-profile-text]")].map((text) =>
        relative(text.getBoundingClientRect()),
      );
      const placed = placeArrivalLabels(spots, { width: origin.width, height: origin.height }, obstacles);
      const next: LabelShift[] = waypoints.map(() => ({ x: 0, y: 0 }));
      labels.forEach((label, at) => {
        next[Number(label.dataset.arrivalLabel)] = placed[at];
      });
      setShifts((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(chart);
    return () => observer.disconnect();
  }, [layoutKey]);

  return (
    <>
      {waypoints.map(({ km }, index) => {
        const travelled = travelledKm !== null && km <= travelledKm;
        const arrival = arrivals[index];
        const left = `${(xOf(km) / PROFILE_VIEW_WIDTH) * 100}%`;
        // 測る前（初めの描画）は真下の真ん中に置く。置ける所が無ければ見せず、測り直せるよう大きさは残す。
        const shift = shifts[index] ?? { x: 0, y: 0 };
        return (
          <Fragment key={index}>
            <span
              role="img"
              aria-label={`${pinMarkName("waypoint", String(index + 1))}（${km.toFixed(1)}km地点${arrival === null ? "" : `・${arrival}`}）`}
              className={cn(
                "pointer-events-none absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2",
                INSIDE_CHART_CLASS,
              )}
              style={{
                ...insideChart(left, WAYPOINT_MARK_PX),
                opacity: travelled ? mapDisplay.route.opacities.travelled : undefined,
              }}
            >
              <PointMark role="waypoint" label={String(index + 1)} originLocated={false} size={WAYPOINT_MARK_PX} />
            </span>
            {/* 時刻は印の中ではなく図の上に置き、図の内側へ寄せても印の箱からはみ出さない。 */}
            {arrival !== null && (
              <span
                data-arrival-label={index}
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute whitespace-nowrap",
                  shift.y === null && "invisible",
                  LABEL_CLASS,
                  profileTextClass(riding),
                )}
                style={{
                  left,
                  top: `calc(50% + ${WAYPOINT_MARK_PX / 2}px)`,
                  transform: `translate(calc(-50% + ${shift.x}px), ${shift.y ?? 0}px)`,
                }}
              >
                {arrival}
              </span>
            )}
          </Fragment>
        );
      })}
      {travelledKm !== null && (
        <span
          role="img"
          aria-label="現在地"
          data-progress="mark"
          className={cn(
            "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white bg-[var(--color-accent)] shadow",
            INSIDE_CHART_CLASS,
          )}
          style={{
            ...insideChart(`${(xOf(travelledKm) / PROFILE_VIEW_WIDTH) * 100}%`, PROGRESS_MARK_PX),
            top: `${((progressMarkY ?? PROFILE_VIEW_HEIGHT / 2) / PROFILE_VIEW_HEIGHT) * 100}%`,
          }}
        />
      )}
      {valueTicks.map((tick) => (
        <span
          key={tick.label}
          data-profile-text
          className={cn("pointer-events-none absolute left-1 -translate-y-1/2", LABEL_CLASS, profileTextClass(riding))}
          style={{ top: `${(tick.y / PROFILE_VIEW_HEIGHT) * 100}%` }}
        >
          {tick.label}
        </span>
      ))}
      <div
        ref={axisRef}
        className="pointer-events-none absolute inset-x-1 bottom-0 flex justify-between text-[var(--color-muted)] tabular-nums"
      >
        <span data-profile-text className={profileTextClass(riding)}>
          0
        </span>
        <span data-profile-text className={profileTextClass(riding)}>
          {widthKm.toFixed(1)}km
        </span>
      </div>
    </>
  );
}
