"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/Button/Button";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover/Popover";
import { CompassNeedleIcon, RideZoomIcon, ZoomInIcon, ZoomOutIcon } from "@/components/ui/icons/icons";
import { useAxisCatalog } from "@/hooks/useAxisCatalog";
import { axisNamesUsing } from "@/lib/catalogAxis";
import { normalizeDeg } from "@/lib/cardinalLabel";
import { cn } from "@/lib/cn";
import { LENS_LINK_CLASS, LENS_LINK_DESCRIPTION } from "@/lib/lensLink";
import { mapOverlayEdge } from "@/lib/mapOverlayEdges";

import { HEADING_LABELS, headingOf } from "../mapHeading";
import { nearestRideZoomStep } from "../MapView/rideZoom";

interface MapNavigationControlProps {
  /** 地図の向き（地図の上が真北から時計回りに何度か）。 */
  bearing: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** ダイヤルで地図の向きを変えた。 */
  onBearingChange: (bearing: number) => void;
  /** 北を上に戻す。 */
  onResetNorth: () => void;
  /** いまの「評価で塗る」の周りの道の塗りが、地図の向きで決まっている。 */
  linked: boolean;
  /** 走行モードの間だけ渡る。拡大・縮小の代わりに倍率のボタンを出し、方位磁針はダイヤルを開かず、北が上と進む向きが上を切り替える。 */
  ride: { headingUp: boolean; onToggleHeadingUp: () => void; zoomBase: number; onNextZoom: () => void } | null;
}

const DIAL_SIZE_PX = 176;
const KEY_STEP_DEG = 5;
const TICK_STEP_DEG = 15;
// ダイヤルの絵の座標（中心が0、外周の半径が RING_RADIUS）。
const RING_RADIUS = 86;
const LABEL_RADIUS = 60;
const ZOOM_GESTURE_USAGE = "地図を1回たたいてから、続けて触れたまま上下に滑らせても拡大・縮小できます。";

/** 中心から角度`deg`（上が0・時計回り）へ半径`r`の点。 */
function pointAt(deg: number, r: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [r * Math.sin(rad), -r * Math.cos(rad)];
}

/** 地図の右上の列: 拡大・縮小（走行モードの間は倍率のボタン）と、地図の北を指す方位磁針。方位磁針を押すと、地図の向きを回す
 * ダイヤルが開く。 */
export default function MapNavigationControl({
  bearing,
  onZoomIn,
  onZoomOut,
  onBearingChange,
  onResetNorth,
  linked,
  ride,
}: MapNavigationControlProps) {
  const heading = headingOf(bearing);
  // 北が上でないことを縁で示す（走行モードの間は、進む向きが上の間）。
  const turned = ride !== null ? ride.headingUp : heading.degrees !== 0;
  const compassClassName = cn(
    "rounded-t-none border-t border-[var(--color-border)] shadow-none",
    turned && "shadow-[inset_0_0_0_2px_var(--color-accent)]",
    linked && LENS_LINK_CLASS,
  );
  const needle = (
    <span aria-hidden="true" className="inline-flex" style={{ transform: `rotate(${-bearing}deg)` }}>
      <CompassNeedleIcon />
    </span>
  );
  return (
    <div
      className="absolute top-[var(--map-ctrl-margin)] right-[var(--map-ctrl-margin)] z-[var(--z-map-control)] flex flex-col rounded-[4px] shadow-[0_0_0_2px_rgba(0,0,0,0.1)]"
      {...mapOverlayEdge("right")}
    >
      {ride !== null ? (
        <RideZoomButton zoomBase={ride.zoomBase} onNextZoom={ride.onNextZoom} />
      ) : (
        <>
          <Button
            variant="mapCtrl"
            size="mapCtrl"
            className="rounded-b-none shadow-none"
            aria-label="拡大"
            usage={`地図を拡大します。${ZOOM_GESTURE_USAGE}`}
            onClick={onZoomIn}
          >
            <ZoomInIcon />
          </Button>
          <Button
            variant="mapCtrl"
            size="mapCtrl"
            className="rounded-none border-t border-[var(--color-border)] shadow-none"
            aria-label="縮小"
            usage={`地図を縮小します。${ZOOM_GESTURE_USAGE}`}
            onClick={onZoomOut}
          >
            <ZoomOutIcon />
          </Button>
        </>
      )}
      {ride !== null ? (
        <Button
          variant="mapCtrl"
          size="mapCtrl"
          className={compassClassName}
          aria-label={ride.headingUp ? "北を上にする（いまは進む向きが上）" : "進む向きを上にする（いまは北が上）"}
          aria-description={linked ? LENS_LINK_DESCRIPTION : undefined}
          usage="走っている間は、押すと北が上と進む向きが上を切り替えます。"
          onClick={ride.onToggleHeadingUp}
        >
          {needle}
        </Button>
      ) : (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="mapCtrl"
              size="mapCtrl"
              className={compassClassName}
              aria-label="地図の向き"
              aria-description={linked ? LENS_LINK_DESCRIPTION : undefined}
              usage="針は地図の北を指します。押すと、地図を回すダイヤルが開きます。"
            >
              {needle}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="p-2" side="left" align="start" sideOffset={8}>
            <HeadingDial
              bearing={bearing}
              heading={heading}
              onBearingChange={onBearingChange}
              onResetNorth={onResetNorth}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

/** 走行モードの倍率のボタン: 押すたびに基準の倍率を中→遠→近と回す。絵は基準の倍率にいちばん近い段。 */
function RideZoomButton({ zoomBase, onNextZoom }: { zoomBase: number; onNextZoom: () => void }) {
  const step = nearestRideZoomStep(zoomBase);
  return (
    <Button
      variant="mapCtrl"
      size="mapCtrl"
      className="rounded-b-none shadow-none"
      aria-label={`倍率（いまは${step.label}）`}
      usage="押すたびに、追う地図の倍率を中・遠・近の順に切り替えます。2本指でつまんでも変えられます。速く走るほど、その倍率から引いて先を見せます。"
      onClick={onNextZoom}
    >
      <RideZoomIcon reach={step.reach} />
    </Button>
  );
}

interface HeadingDialProps {
  bearing: number;
  heading: { label: string; degrees: number };
  onBearingChange: (bearing: number) => void;
  onResetNorth: () => void;
}

/** 地図と一緒に回る方位の輪。輪をなぞると地図が回り、真ん中の針を押すと北が上に戻る。 */
function HeadingDial({ bearing, heading, onBearingChange, onResetNorth }: HeadingDialProps) {
  const dialRef = useRef<HTMLDivElement>(null);
  // 向きで値の変わる評価の名前は軸カタログから引く。無ければ評価に触れる文を出さない。
  const bearingAxes = axisNamesUsing(useAxisCatalog().axes, "bearing_deg");

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
    };
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
          輪をなぞると地図が回り、真ん中の針を押すと北が上に戻ります。
          {bearingAxes &&
            `${bearingAxes}で周りの道を塗るときと、道の評価を見るときの走る向きは、地図の上の向きを8方位に丸めた向きです。ルートの評価は、ルートを実際に走る向きで決まります。`}
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
          <span aria-hidden="true" className="inline-flex" style={{ transform: `rotate(${-bearing}deg)` }}>
            <CompassNeedleIcon size={28} />
          </span>
        </Button>
      </div>
    </div>
  );
}
