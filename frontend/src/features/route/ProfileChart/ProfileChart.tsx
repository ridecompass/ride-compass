"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { pinMarkName } from "@/components/PinMark/PinMark";
import PointMark from "@/components/PinMark/PointMark";
import { columnAtKm } from "@/features/route/DifficultyProfile/profileGeometry";
import { roundToDigits } from "@/lib/numberFormat";
import { pointAlongSegment, routeStretches, type RouteStretch } from "@/lib/routeDistance";
import { mapDisplay } from "@/types/generated/mapDisplay";
import palette from "@/types/generated/palette.json";
import type { RouteSegmentDetail, SelectedRouteSegment } from "@/types/route";

/** 描画の座標。横は距離を`PROFILE_VIEW_WIDTH`へ、縦は`PROFILE_VIEW_HEIGHT`の中へ描き、枠いっぱいへ伸ばす。 */
const PROFILE_VIEW_WIDTH = 1000;
export const PROFILE_VIEW_HEIGHT = 100;
/** 矢印キー1回で動く距離（全長に対する割合）。 */
const KEY_STEP_RATIO = 0.01;

export type ProfileScale = {
  readonly columns: readonly RouteStretch<RouteSegmentDetail>[];
  /** ルートの長さ。 */
  readonly routeKm: number;
  /** 横軸の右端の距離。 */
  readonly widthKm: number;
  /** 距離を描画の横座標へ。 */
  readonly xOf: (km: number) => number;
};

/** 区間の並びと横軸。横軸の右端は`scaleKm`とルートの長さの長い方。 */
export function useProfileScale(segments: readonly RouteSegmentDetail[], scaleKm: number): ProfileScale {
  const columns = useMemo(() => routeStretches(segments), [segments]);
  const routeKm = columns.length === 0 ? 0 : columns[columns.length - 1].endKm;
  const widthKm = Math.max(scaleKm, routeKm);
  return useMemo(
    () => ({
      columns,
      routeKm,
      widthKm,
      xOf: (km: number) => (widthKm > 0 ? roundToDigits((km / widthKm) * PROFILE_VIEW_WIDTH, 2) : 0),
    }),
    [columns, routeKm, widthKm],
  );
}

interface ProfileChartProps {
  scale: ProfileScale;
  /** 図の名前。押せる図では、動かすとその地点を地図に出すことを添える。 */
  label: string;
  /** 押せる図の使い方の文。 */
  usage: string;
  selected: SelectedRouteSegment | null;
  /** なぞる・押して離すと、その地点の区間を選ぶ。無ければ押せない見るだけの図にする（走行中は地図を追うことに専念する）。 */
  onSelect?: (selection: SelectedRouteSegment) => void;
  /** 走行中の現在地のルートの上の距離。印を引き、始点からそこまでを走り終えた区間として薄める。 */
  progressKm?: number | null;
  /** 現在地の印の縦の位置（0〜`PROFILE_VIEW_HEIGHT`）。無ければ図の中ほどに置く。 */
  progressMarkY?: number | null;
  /** 置いた経由地を通る所のルートの上の距離（置いた順）。縦の線と、地図のピンと同じ番号の印を出す。走り終えた経由地は薄める。 */
  waypointKms: readonly number[];
  /** 図の中身（`scale.xOf`の横座標と、0〜`PROFILE_VIEW_HEIGHT`の縦座標で描く）。 */
  children: ReactNode;
  /** 図の下の1行。区間を選んでいれば、その地点の距離を受け取る。 */
  caption?: (pointKm: number | null) => ReactNode;
}

/** 道のりに沿った図の枠。横が距離で、選んだ区間の帯・走行中の現在地・動かした地点の線を中身の上に引き、下に距離の目盛りを
 * 出す。1本の指（マウス）で横になぞるか押して離すと、その距離の地点を選ぶ（地図に印が出て、下にその区間の詳細が出る）。
 * **押しただけでは選ばず、途中で2本目の指が触れた操作は選択にしない**——図の上で始めたピンチ（拡大しようとした操作）で
 * 区間が選ばれ、表示が区間の詳細へ切り替わらないようにする。**縦に動き出した操作も選択にしない**——縦のなぞりは、図を
 * 載せたシート・パネルのスクロールとしてブラウザに渡す（図の上に指を置いても下へ送れる）。高さは置き場が CSS の変数
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
}: ProfileChartProps) {
  const [scrubKm, setScrubKm] = useState<number | null>(null);
  const clipId = `profile${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  // 図に触れている指（ポインター）と、いまの操作に2本目が加わったか、操作の始まりの点と、動き出した向き（横は地点を選び、
  // 縦はスクロールに渡す。まだ動いていなければnull）。
  const gesture = useRef<{
    pointers: Set<number>;
    multi: boolean;
    start: { x: number; y: number };
    axis: "x" | "y" | null;
  }>({ pointers: new Set(), multi: false, start: { x: 0, y: 0 }, axis: null });
  // 画面のどこかに触れている指。2本目は図の外に触れることがあり、図のポインターだけでは数えられない
  // （タッチイベントの指の数は、図のpointermoveより後に届くので間に合わない）。
  const screenPointers = useRef<Set<number>>(new Set());
  useEffect(() => {
    const pointers = screenPointers.current;
    const down = (event: globalThis.PointerEvent) => {
      pointers.add(event.pointerId);
      if (pointers.size > 1 && gesture.current.pointers.size > 0) gesture.current.multi = true;
    };
    const up = (event: globalThis.PointerEvent) => pointers.delete(event.pointerId);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, []);
  const { columns, routeKm, widthKm, xOf } = scale;
  if (routeKm <= 0) return null;

  const selectedColumn = selected === null ? undefined : columns.find((column) => column.segment === selected.segment);
  // 自分で動かした地点がいま選ばれている区間の中にあるときだけ線を引く（地図で区間を押したときは区間の帯だけ）。
  const cursorKm =
    selectedColumn !== undefined &&
    scrubKm !== null &&
    scrubKm >= selectedColumn.startKm &&
    scrubKm <= selectedColumn.endKm
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

  function releasePointer(pointerId: number) {
    gesture.current.pointers.delete(pointerId);
    if (gesture.current.pointers.size === 0) {
      gesture.current.multi = false;
      gesture.current.axis = null;
    }
  }

  // 動き出した向きを、始まりの点から横と縦のどちらへ多く動いたかで1度だけ決める（同じだけなら、まだ決めない）。
  // 縦に決まった操作は、ブラウザがスクロールに取って取り消す（pointercancel）。
  function axisOf(event: PointerEvent<SVGSVGElement>): "x" | "y" | null {
    if (gesture.current.axis === null) {
      const dx = Math.abs(event.clientX - gesture.current.start.x);
      const dy = Math.abs(event.clientY - gesture.current.start.y);
      if (dx !== dy) gesture.current.axis = dx > dy ? "x" : "y";
    }
    return gesture.current.axis;
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
                onPointerDown: (event: PointerEvent<SVGSVGElement>) => {
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  if (gesture.current.pointers.size === 0)
                    gesture.current.start = { x: event.clientX, y: event.clientY };
                  gesture.current.pointers.add(event.pointerId);
                  // 画面全体の指は窓の捕捉の段で先に数えてあるので、図の上の指もそこに含まれる。
                  if (screenPointers.current.size > 1) gesture.current.multi = true;
                },
                onPointerMove: (event: PointerEvent<SVGSVGElement>) => {
                  if (event.buttons === 0 || gesture.current.multi || !gesture.current.pointers.has(event.pointerId))
                    return;
                  if (axisOf(event) === "x") selectAt(kmAtPointer(event));
                },
                onPointerUp: (event: PointerEvent<SVGSVGElement>) => {
                  if (
                    !gesture.current.multi &&
                    gesture.current.pointers.has(event.pointerId) &&
                    gesture.current.axis !== "y"
                  )
                    selectAt(kmAtPointer(event));
                  releasePointer(event.pointerId);
                },
                onPointerCancel: (event: PointerEvent<SVGSVGElement>) => releasePointer(event.pointerId),
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
          {travelledKm !== null && (
            <line
              data-progress="position"
              x1={xOf(travelledKm)}
              x2={xOf(travelledKm)}
              y1={0}
              y2={PROFILE_VIEW_HEIGHT}
              className="stroke-[var(--color-accent)]"
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
        {waypointKms.map((km, index) => (
          <span
            key={index}
            role="img"
            aria-label={`${pinMarkName("waypoint", String(index + 1))}（${km.toFixed(1)}km地点）`}
            className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{
              left: `${(xOf(km) / PROFILE_VIEW_WIDTH) * 100}%`,
              opacity: travelledKm !== null && km <= travelledKm ? mapDisplay.route.opacities.travelled : undefined,
            }}
          >
            <PointMark role="waypoint" label={String(index + 1)} originLocated={false} />
          </span>
        ))}
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
        <div className="pointer-events-none absolute inset-x-1 bottom-0 flex justify-between text-[length:var(--font-size-xs)] text-[var(--color-muted)] tabular-nums">
          <span>0</span>
          <span>{widthKm.toFixed(1)}km</span>
        </div>
      </div>
      {caption?.(selectedColumn === undefined ? null : positionKm)}
    </div>
  );
}
