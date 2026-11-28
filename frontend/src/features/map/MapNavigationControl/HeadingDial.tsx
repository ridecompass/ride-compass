"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button/Button";
import { GuideText } from "@/components/ui/GuideText/GuideText";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { CompassNeedleIcon } from "@/components/ui/icons/icons";
import { normalizeDeg } from "@/lib/cardinalLabel";
import { BURDEN_PAINT_NAME } from "@/lib/screenNames";

import { HEADING_LABELS } from "../mapHeading";

const DIAL_SIZE_PX = 176;
const KEY_STEP_DEG = 5;
const TICK_STEP_DEG = 15;
// ダイヤルの絵の座標（中心が0、外周の半径が RING_RADIUS）。
const RING_RADIUS = 86;
const LABEL_RADIUS = 60;

/** 中心から角度`deg`（上が0・時計回り）へ半径`r`の点。 */
function pointAt(deg: number, r: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [r * Math.sin(rad), -r * Math.cos(rad)];
}

/** 地図の北を指す針。 */
export function Needle({ bearing, size }: { bearing: number; size?: number }) {
  return (
    <span aria-hidden="true" className="inline-flex" style={{ transform: `rotate(${-bearing}deg)` }}>
      <CompassNeedleIcon size={size} />
    </span>
  );
}

interface HeadingDialProps {
  bearing: number;
  heading: { label: string; degrees: number };
  onBearingChange: (bearing: number) => void;
  onResetNorth: () => void;
}

/** 地図と一緒に回る方位の輪。輪をなぞると地図が回り、真ん中の針を押すと北が上に戻る。 */
export default function HeadingDial({ bearing, heading, onBearingChange, onResetNorth }: HeadingDialProps) {
  const dialRef = useRef<HTMLDivElement>(null);
  // なぞっている間にwindowへ付けた受け手を外す。なぞる途中でダイヤルを閉じても（Escape等）外す。
  const endDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endDragRef.current?.(), []);

  /** 中心からポインタへの角度（上が0・時計回り）。 */
  function angleAt(clientX: number, clientY: number): number {
    const rect = dialRef.current!.getBoundingClientRect();
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    return (Math.atan2(dx, -dy) * 180) / Math.PI;
  }

  // 輪は地図と一緒に回るので、輪を時計回りになぞった分だけ地図の向きを反時計回りへ戻す（指の下の方位が指に付いてくる）。
  // pointer capture は環境によって効かないことがあるので、window で動きを受ける。
  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest("button")) return;
    const startAngle = angleAt(event.clientX, event.clientY);
    const startBearing = bearing;
    const onMove = (move: PointerEvent) =>
      onBearingChange(normalizeDeg(startBearing - (angleAt(move.clientX, move.clientY) - startAngle)));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      endDragRef.current = null;
    };
    endDragRef.current?.();
    endDragRef.current = onUp;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function turnByKey(event: React.KeyboardEvent<HTMLDivElement>) {
    let delta = 0;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") delta = -KEY_STEP_DEG;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") delta = KEY_STEP_DEG;
    else return;
    event.preventDefault();
    onBearingChange(normalizeDeg(bearing + delta));
  }

  const ticks = Array.from({ length: 360 / TICK_STEP_DEG }, (_, i) => i * TICK_STEP_DEG);
  return (
    <div className="flex flex-col gap-1" style={{ width: DIAL_SIZE_PX }}>
      <div className="flex items-center justify-between">
        <InfoPopover triggerAriaLabel="地図の向きの使い方">
          <GuideText
            text={`輪をなぞると地図が回ります。真ん中の針を押すと、北が上に戻ります。\n・「${BURDEN_PAINT_NAME}」の周りの道の色と道の小窓は、地図を回しても変わりません。坂や風のように向きで変わる走りにくさは、きつい向きの値で示します[走行中は進む向きの値]。\n・ルートの走りにくさは、実際に走る向きで決まります。`}
          />
        </InfoPopover>
        <span className="tabular-nums">
          <span className="text-[length:var(--font-size-md)] font-semibold text-[var(--color-accent)]">
            {heading.label}
          </span>{" "}
          <span className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">{heading.degrees}°</span>
        </span>
      </div>
      <div
        ref={dialRef}
        className="relative cursor-grab touch-none rounded-full active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
        style={{ width: DIAL_SIZE_PX, height: DIAL_SIZE_PX }}
        role="slider"
        aria-label="地図の向き"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={heading.degrees}
        aria-valuetext={`${heading.label} ${heading.degrees}°`}
        tabIndex={0}
        data-usage="輪をなぞると地図が回ります。"
        onPointerDown={startDrag}
        onKeyDown={turnByKey}
      >
        <svg viewBox="-100 -100 200 200" width={DIAL_SIZE_PX} height={DIAL_SIZE_PX} aria-hidden="true">
          <circle r={RING_RADIUS} fill="var(--color-surface-2)" stroke="var(--color-border)" strokeWidth={2} />
          <g transform={`rotate(${-bearing})`}>
            {ticks.map((deg) => {
              const major = deg % 45 === 0;
              const [x1, y1] = pointAt(deg, RING_RADIUS - 2);
              const [x2, y2] = pointAt(deg, RING_RADIUS - (major ? 14 : 8));
              return (
                <line
                  key={deg}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={deg === 0 ? "var(--color-danger)" : "var(--color-muted)"}
                  strokeWidth={major ? 3 : 1.5}
                  strokeLinecap="round"
                />
              );
            })}
            {HEADING_LABELS.map((label, index) => {
              const cardinal = index % 2 === 0;
              const [x, y] = pointAt(index * 45, LABEL_RADIUS);
              return (
                <text
                  key={label}
                  x={x}
                  y={y}
                  // 輪は回しても、文字は正立のまま読ませる。
                  transform={`rotate(${bearing} ${x} ${y})`}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={cardinal ? 22 : 13}
                  fontWeight={cardinal ? 600 : 400}
                  fill={label === "N" ? "var(--color-danger)" : cardinal ? "var(--foreground)" : "var(--color-muted)"}
                >
                  {label}
                </text>
              );
            })}
          </g>
          <path d="M0 -100 -8 -88H8Z" fill="var(--color-accent)" />
        </svg>
        <Button
          variant="float"
          size="bare"
          shape="pill"
          className="absolute top-1/2 left-1/2 size-12 -translate-x-1/2 -translate-y-1/2"
          aria-label="北を上にする"
          usage="押すと北が上に戻ります。"
          onClick={onResetNorth}
        >
          <Needle bearing={bearing} size={28} />
        </Button>
      </div>
    </div>
  );
}
