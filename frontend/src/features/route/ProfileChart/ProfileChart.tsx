"use client";

import { useId, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { columnAtKm } from "@/features/route/DifficultyProfile/profileGeometry";
import { roundToDigits } from "@/lib/numberFormat";
import { findSameSegment, kmOfPickedPoint, pointAlongSegment } from "@/lib/routeDistance";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import type { SelectedRouteSegment } from "@/types/route";

import ProfileMarks, { type ValueTick } from "./ProfileMarks";
import { PROFILE_VIEW_HEIGHT, PROFILE_VIEW_WIDTH, type ProfileScale } from "./profileScale";
import { useProfileGesture } from "./useProfileGesture";

/** 矢印キー1回で動く距離（全長に対する割合）。 */
const KEY_STEP_RATIO = 0.01;

interface ProfileChartProps {
  scale: ProfileScale;
  /** 図の名前。押せる図では、動かすとその地点を地図に出すことを添える。 */
  label: string;
  /** 押せる図の使い方の文。 */
  usage: string;
  selected: SelectedRouteSegment | null;
  /** なぞる・押して離すと、その地点の区間を選ぶ。無ければ押せない見るだけの図にする。 */
  onSelect?: (selection: SelectedRouteSegment) => void;
  /** 走行中の現在地のルートの上の距離。印を引き、始点からそこまでを走り終えた区間として薄める。 */
  progressKm?: number | null;
  /** 現在地の印の縦の位置（0〜`PROFILE_VIEW_HEIGHT`）。無ければ図の中ほどに置く。 */
  progressMarkY?: number | null;
  /** 置いた経由地を通る所のルートの上の距離（置いた順）。縦の線と、地図のピンと同じ番号の印を出す。走り終えた経由地は薄める。 */
  waypointKms: readonly number[];
  /** 図の中身（`scale.xOf`の横座標と、0〜`PROFILE_VIEW_HEIGHT`の縦座標で描く）。 */
  children: ReactNode;
  /** 図の下の1行。 */
  caption?: ReactNode;
  /** 縦の値の目盛り（0〜`PROFILE_VIEW_HEIGHT`の縦の位置と文字）。図の左の端に重ねる。 */
  valueTicks?: readonly ValueTick[];
  /** 走行中の地図の下の図。目盛りの文字を大きくする。 */
  riding?: boolean;
}

/** 道のりに沿った図の枠。横が距離で、選んだ区間の帯・走行中の現在地・動かした地点の線を中身の上に引き、下に距離の目盛りを
 * 出す。1本の指（マウス）で横になぞるか押して離すと、その距離の地点を選ぶ（地図に印が出て、下にその区間の詳細が出る。
 * 選ばない操作は`features/route/ProfileChart/useProfileGesture.ts: useProfileGesture`が決める）。高さは置き場が CSS の変数
 * `--profile-chart-height` で決める（無ければ走行中の地図の下に出す図の高さ）。 */
export default function ProfileChart({
  scale,
  label,
  usage,
  selected,
  onSelect,
  progressKm = null,
  progressMarkY = null,
  waypointKms,
  children,
  caption,
  valueTicks = [],
  riding = false,
}: ProfileChartProps) {
  const [scrubKm, setScrubKm] = useState<number | null>(null);
  const clipId = `profile${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const pointerHandlers = useProfileGesture();
  const { columns, routeKm, widthKm, xOf } = scale;
  if (routeKm <= 0) return null;

  const selectedColumn =
    selected === null ? undefined : findSameSegment(columns, selected.segment, (column) => column.segment);
  // 線を引く地点。図で選んだ区間は、自分で動かした地点がその区間の中にあるときだけ。地図で押した区間（地図は区間を自分の
  // 地物から組み直すので、図の区間と同じものではない）は、押した所を区間の道なりの形に当てた地点。
  const cursorKm =
    selected === null || selectedColumn === undefined
      ? null
      : selectedColumn.segment !== selected.segment
        ? kmOfPickedPoint(selectedColumn, selected)
        : scrubKm !== null && scrubKm >= selectedColumn.startKm && scrubKm <= selectedColumn.endKm
          ? scrubKm
          : null;
  const positionKm = cursorKm ?? selectedColumn?.startKm ?? 0;
  const travelledKm = progressKm === null ? null : Math.min(routeKm, Math.max(0, progressKm));

  function selectAt(km: number) {
    // 横軸が候補より長いとき、候補の終わりより右は終点として選び、線も終点に引く。
    const clamped = Math.min(routeKm, Math.max(0, km));
    const hit = columnAtKm(columns, clamped);
    if (hit === null) return;
    const [longitude, latitude] = pointAlongSegment(hit.column.segment, hit.fraction);
    setScrubKm(clamped);
    onSelect?.({ segment: hit.column.segment, latitude, longitude });
  }

  function kmAtPointer(event: PointerEvent<SVGSVGElement>): number {
    const rect = event.currentTarget.getBoundingClientRect();
    return rect.width > 0 ? ((event.clientX - rect.left) / rect.width) * widthKm : 0;
  }

  function handleKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const step = routeKm * KEY_STEP_RATIO;
    const next =
      event.key === "ArrowRight"
        ? positionKm + step
        : event.key === "ArrowLeft"
          ? positionKm - step
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? routeKm
              : null;
    if (next === null) return;
    event.preventDefault();
    selectAt(next);
  }

  return (
    <div className="flex flex-col gap-0.5">
      {/* 距離の目盛りは図の中の下の角に重ね、図の下に段を取らない（スマホのシートの低い高さで図を大きく見せる）。 */}
      <div className="relative">
        <svg
          viewBox={`0 0 ${PROFILE_VIEW_WIDTH} ${PROFILE_VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          // 押せる図は縦のなぞりだけをブラウザ（シート・パネルのスクロール）へ渡し、横の動きは地点を選ぶ操作に使う。見るだけの図は
          // どの動きもブラウザへ渡さない。
          className="h-[var(--profile-chart-height,7rem)] w-full touch-none rounded-sm data-[pickable=true]:touch-pan-y bg-[var(--color-surface-2)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] data-[pickable=true]:cursor-crosshair"
          data-pickable={onSelect !== undefined}
          {...(onSelect === undefined
            ? { role: "img", "aria-label": label }
            : {
                role: "slider",
                tabIndex: 0,
                "aria-label": `${label}（動かすと、その地点を地図に出す）`,
                "data-usage": usage,
                "aria-valuemin": 0,
                "aria-valuemax": roundToDigits(routeKm, 1),
                "aria-valuenow": roundToDigits(positionKm, 1),
                "aria-valuetext": `${positionKm.toFixed(1)} km地点`,
                ...pointerHandlers((event) => selectAt(kmAtPointer(event))),
                onKeyDown: handleKeyDown,
              })}
        >
          {selectedColumn !== undefined && (
            <rect
              x={xOf(selectedColumn.startKm)}
              y={0}
              width={Math.max(xOf(selectedColumn.endKm) - xOf(selectedColumn.startKm), 2)}
              height={PROFILE_VIEW_HEIGHT}
              fill={palette.semantic.inspected}
              opacity={0.25}
            />
          )}
          {travelledKm === null ? (
            children
          ) : (
            <>
              <defs>
                <clipPath id={`${clipId}-travelled`}>
                  <rect x={0} y={0} width={xOf(travelledKm)} height={PROFILE_VIEW_HEIGHT} />
                </clipPath>
                <clipPath id={`${clipId}-ahead`}>
                  <rect x={xOf(travelledKm)} y={0} width={PROFILE_VIEW_WIDTH} height={PROFILE_VIEW_HEIGHT} />
                </clipPath>
                <filter id={`${clipId}-gray`}>
                  <feColorMatrix type="saturate" values="0" />
                </filter>
              </defs>
              {/* 走り終えた所は色を抜いて薄め、残りは元の色のまま描く。 */}
              <g
                data-progress="travelled"
                clipPath={`url(#${clipId}-travelled)`}
                filter={`url(#${clipId}-gray)`}
                opacity={mapDisplay.route.opacities.travelled}
              >
                {children}
              </g>
              <g data-progress="ahead" clipPath={`url(#${clipId}-ahead)`}>
                {children}
              </g>
            </>
          )}
          {waypointKms.map((km, index) => (
            <line
              key={index}
              data-waypoint={index + 1}
              x1={xOf(km)}
              x2={xOf(km)}
              y1={0}
              y2={PROFILE_VIEW_HEIGHT}
              className="stroke-[var(--color-muted-strong)]"
              strokeWidth={1}
              strokeDasharray="3 2"
              vectorEffect="non-scaling-stroke"
              opacity={travelledKm !== null && km <= travelledKm ? mapDisplay.route.opacities.travelled : undefined}
            />
          ))}
          {/* 現在地の線は、標高等の折れ線の色（青）と見分けるため文字の色で引き、青は地図の現在地と同じ丸い印だけに使う。 */}
          {travelledKm !== null && (
            <line
              data-progress="position"
              x1={xOf(travelledKm)}
              x2={xOf(travelledKm)}
              y1={0}
              y2={PROFILE_VIEW_HEIGHT}
              className="stroke-[var(--foreground)]"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {cursorKm !== null && (
            <line
              x1={xOf(cursorKm)}
              x2={xOf(cursorKm)}
              y1={0}
              y2={PROFILE_VIEW_HEIGHT}
              stroke={palette.semantic.inspected}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        <ProfileMarks
          xOf={xOf}
          widthKm={widthKm}
          waypointKms={waypointKms}
          travelledKm={travelledKm}
          progressMarkY={progressMarkY}
          valueTicks={valueTicks}
          riding={riding}
        />
      </div>
      {caption}
    </div>
  );
}
