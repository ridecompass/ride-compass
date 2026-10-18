"use client";

// 較正の画面の折れ点の曲線。動かせるのは渡された点（0点・100点の端）だけで、横（入力値）にだけ動く。保存済みの線と
// 地図の段の境界を重ね、境界は上下に動かせる。
//
// 背景には実データの分布（生値のヒストグラムと分位）を薄く重ねる。折れ点だけを見ても
// 「その形が実際の道路のどこに効いているか」は分からず、値が集中する帯の外側で曲線を
// 動かしても結果は変わらない。重ね方の計算はcurveDistributionOverlay.ts（DOM非依存の
// 純関数）が行い、このファイルは描画のみ。

import { useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { roundToDigits } from "@/lib/numberFormat";
import { niceStep, snapToStep } from "./breakpointTools";
import {
  maxBarShare,
  offRangeShare,
  quantileMarkers,
  visibleBars,
  OFF_RANGE_NOTICE_THRESHOLD,
} from "./curveDistributionOverlay";
import type { ValueDistribution } from "./scoreDistribution";

/** きりのいい目盛り位置の一覧（min〜maxの範囲内、niceStep刻み）。 */
function niceTicks(min: number, max: number): number[] {
  const step = niceStep(max - min || 1);
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) {
    ticks.push(roundToDigits(v, 3));
  }
  return ticks;
}

/** 描く枠の大きさ（viewBoxの単位）。 */
const FRAME = { width: 720, height: 320, padding: 36 } as const;

/** 横にだけ動かせる点。`index`は`breakpoints`の位置。 */
export interface CurveHandle {
  index: number;
  label: string;
}

/** 地図の段の境界（得点）。横の破線で描き、上下に動かせる。 */
export interface CurveBoundary {
  value: number;
  color: string;
}

/** 矢印キーごとの、入力値を動かす向き。 */
const ARROW_SIGNS = new Map<string, 1 | -1>([
  ["ArrowRight", 1],
  ["ArrowLeft", -1],
]);

/** 折れ点の曲線。横軸は`xRange`に前後1割の余白を足した範囲に固定し、点を動かしても目盛りが動かないようにする。 */
export function BreakpointCurveEditor({
  breakpoints,
  handles,
  onChangeHandle,
  xRange,
  distribution,
  referenceLine,
  boundaries,
  onChangeBoundary,
}: {
  breakpoints: [number, number][];
  /** 動かせる点。ほかの点は線の上の印になる。 */
  handles: readonly CurveHandle[];
  onChangeHandle: (index: number, value: number) => void;
  xRange: { min: number; max: number };
  /** 折れ点を通す前の生値の分布。背景へ薄く重ねる。未取得・取得不可ならnull。 */
  distribution: ValueDistribution | null;
  /** 比べる線（保存済みの折れ点等）。灰色の破線で後ろに描く。 */
  referenceLine: readonly [number, number][] | null;
  boundaries: readonly CurveBoundary[];
  onChangeBoundary: (index: number, value: number) => void;
}) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const { width, height, padding } = FRAME;
  const ys = breakpoints.map((bp) => bp[1]);
  const xMargin = (xRange.max - xRange.min) * 0.1;
  const xMin = xRange.min - xMargin;
  const xMax = xRange.max + xMargin;
  const yMin = Math.min(0, ...ys);
  const yMax = Math.max(100, ...ys);
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;
  const xSnapStep = niceStep(xSpan);

  function toScreen(bp: [number, number]): [number, number] {
    const sx = padding + ((bp[0] - xMin) / xSpan) * (width - padding * 2);
    const sy = height - padding - ((bp[1] - yMin) / ySpan) * (height - padding * 2);
    return [sx, sy];
  }

  function fromScreen(sx: number, sy: number): [number, number] {
    const x = xMin + ((sx - padding) / (width - padding * 2)) * xSpan;
    const y = yMin + ((height - padding - sy) / (height - padding * 2)) * ySpan;
    return [snapToStep(x, xSnapStep), Math.round(y)];
  }

  const bars = visibleBars(distribution, xMin, xMax);
  const barScale = maxBarShare(bars);
  const markers = quantileMarkers(distribution, xMin, xMax);
  const offRange = offRangeShare(distribution, xMin, xMax);

  const points = breakpoints.map(toScreen);
  const polyline = points.map(([x, y]) => `${x},${y}`).join(" ");
  const referencePolyline = referenceLine?.map((bp) => toScreen([bp[0], bp[1]]).join(",")).join(" ");
  const handleLabels = new Map(handles.map((handle) => [handle.index, handle.label]));

  function pointerToSvg(e: ReactPointerEvent<SVGElement>): [number, number] | null {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return [((e.clientX - rect.left) / rect.width) * width, ((e.clientY - rect.top) / rect.height) * height];
  }
  const xTicks = niceTicks(xMin, xMax);
  const yTicks = [25, 50, 75];

  function handlePointerMove(e: ReactPointerEvent<SVGCircleElement>, index: number) {
    if (e.buttons !== 1) return;
    const position = pointerToSvg(e);
    if (!position) return;
    onChangeHandle(index, fromScreen(...position)[0]);
  }

  function handleBoundaryPointerMove(e: ReactPointerEvent<SVGElement>, index: number) {
    if (e.buttons !== 1) return;
    const position = pointerToSvg(e);
    if (!position) return;
    onChangeBoundary(index, Math.min(100, Math.max(0, fromScreen(...position)[1])));
  }

  function handleBoundaryKeyDown(e: ReactKeyboardEvent<SVGElement>, index: number) {
    const sign = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
    if (sign === 0) return;
    e.preventDefault();
    onChangeBoundary(index, boundaries[index].value + sign * (e.shiftKey ? 10 : 1));
  }

  // 矢印キーでの微調整（左右=入力値をxSnapStep刻み、Shift併用でその10倍）。ドラッグ操作の代替手段として、
  // キーボード操作・スクリーンリーダー利用者にも点を動かす手段を確保する。
  function handleKeyDown(e: ReactKeyboardEvent<SVGCircleElement>, index: number) {
    const sign = ARROW_SIGNS.get(e.key);
    if (!sign) return;
    e.preventDefault();
    onChangeHandle(index, breakpoints[index][0] + sign * xSnapStep * (e.shiftKey ? 10 : 1));
  }

  const dragging = draggingIndex != null ? breakpoints[draggingIndex] : null;
  const draggingScreen = draggingIndex != null ? points[draggingIndex] : null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full touch-none rounded-sm bg-[var(--color-surface-2)]"
      role="img"
      aria-label="折れ点の曲線プレビュー（背景は実データの分布。ドラッグまたは矢印キーで調整可能）"
    >
      {/* 実データの分布。棒は曲線・格子線より先に描いて最背面へ置く（前面に出ると
          折れ点のドラッグ対象が見えにくくなる）。高さは最大の階級を基準に正規化した
          相対値で、縦軸（得点）とは無関係。 */}
      {bars.map((bar) => {
        const [x0] = toScreen([bar.from, 0]);
        const [x1] = toScreen([bar.to, 0]);
        const h = (bar.share / barScale) * (height - padding * 2);
        return (
          <rect
            key={`bar-${bar.from}`}
            x={x0}
            y={height - padding - h}
            width={Math.max(x1 - x0, 0.5)}
            height={h}
            className="pointer-events-none fill-[var(--color-muted)] opacity-20"
          />
        );
      })}
      {markers.map((marker) => {
        const [sx] = toScreen([marker.value, 0]);
        return (
          <g key={`q-${marker.label}`}>
            <line
              x1={sx}
              y1={padding}
              x2={sx}
              y2={height - padding}
              className="pointer-events-none stroke-[var(--color-muted)] opacity-55 [stroke-dasharray:1_3] [stroke-width:1]"
            />
            <text
              x={sx}
              y={padding - 3}
              className="pointer-events-none fill-[var(--color-muted)] text-[7px]"
              textAnchor="middle"
            >
              {marker.label}
            </text>
          </g>
        );
      })}
      {yTicks.map((y) => {
        const [, sy] = toScreen([xMin, y]);
        return (
          <line
            key={`y-${y}`}
            x1={padding}
            y1={sy}
            x2={width - padding}
            y2={sy}
            className="stroke-[var(--color-border)] [stroke-dasharray:2_2] [stroke-width:1]"
          />
        );
      })}
      {xTicks.map((x) => {
        const [sx] = toScreen([x, yMin]);
        return (
          <g key={`x-${x}`}>
            <line
              x1={sx}
              y1={padding}
              x2={sx}
              y2={height - padding}
              className="stroke-[var(--color-border)] [stroke-dasharray:2_2] [stroke-width:1]"
            />
            <text x={sx} y={height - padding + 12} className="fill-[var(--color-muted)] text-[8px]" textAnchor="middle">
              {x}
            </text>
          </g>
        );
      })}
      <line
        x1={padding}
        y1={height - padding}
        x2={width - padding}
        y2={height - padding}
        className="stroke-[var(--color-border-strong)] [stroke-width:1]"
      />
      <line
        x1={padding}
        y1={padding}
        x2={padding}
        y2={height - padding}
        className="stroke-[var(--color-border-strong)] [stroke-width:1]"
      />
      {referencePolyline && (
        <polyline
          points={referencePolyline}
          aria-label="保存済みの線"
          className="pointer-events-none fill-none stroke-[var(--color-muted)] opacity-70 [stroke-dasharray:4_3] [stroke-width:2]"
        />
      )}
      {boundaries.map((boundary, i) => {
        const [, sy] = toScreen([xMin, boundary.value]);
        return (
          <g key={`boundary-${i}`}>
            <line
              x1={padding}
              y1={sy}
              x2={width - padding}
              y2={sy}
              stroke={boundary.color}
              className="pointer-events-none [stroke-dasharray:6_4] [stroke-width:1.5]"
            />
            <rect
              x={width - padding - 30}
              y={sy - 8}
              width={30}
              height={16}
              rx={8}
              stroke={boundary.color}
              tabIndex={0}
              role="slider"
              aria-label={`段の境界${i + 1}`}
              aria-valuenow={boundary.value}
              aria-valuemin={0}
              aria-valuemax={100}
              className="cursor-ns-resize fill-[var(--background)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
              onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
              onPointerMove={(e) => handleBoundaryPointerMove(e, i)}
              onKeyDown={(e) => handleBoundaryKeyDown(e, i)}
            />
            <text
              x={width - padding - 15}
              y={sy + 3}
              className="pointer-events-none fill-[var(--foreground)] text-[9px] tabular-nums"
              textAnchor="middle"
            >
              {boundary.value}
            </text>
          </g>
        );
      })}
      <polyline points={polyline} className="fill-none stroke-[var(--color-accent)] [stroke-width:2]" />
      {points.map(([x, y], i) =>
        !handleLabels.has(i) ? (
          <circle key={i} cx={x} cy={y} r={3} className="pointer-events-none fill-[var(--color-accent)]" />
        ) : (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={7}
            tabIndex={0}
            role="slider"
            aria-label={handleLabels.get(i)}
            aria-valuenow={breakpoints[i][0]}
            className="cursor-grab fill-[var(--color-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              setDraggingIndex(i);
            }}
            onPointerMove={(e) => handlePointerMove(e, i)}
            onPointerUp={() => setDraggingIndex(null)}
            onKeyDown={(e) => handleKeyDown(e, i)}
          />
        ),
      )}
      {/* 表示範囲の外にある延長。黙って切ると「分布は全部見えている」と読めてしまい、
          折れ点が実データの範囲と合っていないこと自体が画面から消える。 */}
      {offRange.below >= OFF_RANGE_NOTICE_THRESHOLD && (
        <text
          x={padding}
          y={padding - 3}
          className="pointer-events-none fill-[var(--foreground)] text-[8px] tabular-nums"
          textAnchor="start"
        >
          ←{(offRange.below * 100).toFixed(0)}%
        </text>
      )}
      {offRange.above >= OFF_RANGE_NOTICE_THRESHOLD && (
        <text
          x={width - padding}
          y={padding - 3}
          className="pointer-events-none fill-[var(--foreground)] text-[8px] tabular-nums"
          textAnchor="end"
        >
          {(offRange.above * 100).toFixed(0)}%→
        </text>
      )}
      {dragging && draggingScreen && (
        <text
          x={draggingScreen[0]}
          y={draggingScreen[1] - 12}
          className="pointer-events-none fill-[var(--foreground)] text-[9px] font-semibold tabular-nums"
          textAnchor="middle"
        >
          {dragging[0]} → {dragging[1]}
        </text>
      )}
    </svg>
  );
}
