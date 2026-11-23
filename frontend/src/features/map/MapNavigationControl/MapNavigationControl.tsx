"use client";

import { Button } from "@/components/ui/Button/Button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover/Popover";
import { RideZoomIcon } from "@/components/ui/icons/icons";
import { ZoomInIcon, ZoomOutIcon } from "@/components/ui/icons/lucideIcons";
import { cn } from "@/lib/cn";
import { LENS_LINK_CLASS, LENS_LINK_DESCRIPTION } from "@/lib/lensLink";
import { mapOverlayEdge } from "@/lib/mapOverlayEdges";

import { headingOf } from "../mapHeading";
import { nearestRideZoomStep } from "../MapView/rideZoom";
import HeadingDial, { Needle } from "./HeadingDial";

interface MapNavigationControlProps {
  /** 地図の向き（地図の上が真北から時計回りに何度か）。 */
  bearing: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** ダイヤルで地図の向きを変えた。 */
  onBearingChange: (bearing: number) => void;
  /** 北を上に戻す。 */
  onResetNorth: () => void;
  /** いまの「負担で塗る」の周りの道の塗りが、地図の向きで決まっている。 */
  linked: boolean;
  /** 走行モードの間だけ渡る。拡大・縮小の代わりに倍率のボタンを出し、方位磁針はダイヤルを開かず、現在地を追っている間は北が上と
   * 進む向きが上を切り替え、追っていない間は北が上に戻す。 */
  ride: {
    headingUp: boolean;
    following: boolean;
    onCompass: () => void;
    zoomBase: number;
    onNextZoom: () => void;
  } | null;
}

const ZOOM_GESTURE_USAGE = "地図を1回タップし、指を離さずに上下へ動かしても拡大・縮小できます。";

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
  const compassProps = {
    variant: "mapCtrl",
    size: "mapCtrl",
    className: cn(
      "rounded-t-none border-t border-[var(--color-border)] shadow-none",
      turned && "shadow-[inset_0_0_0_2px_var(--color-accent)]",
      linked && LENS_LINK_CLASS,
    ),
    "aria-description": linked ? LENS_LINK_DESCRIPTION : undefined,
    children: <Needle bearing={bearing} />,
  } as const;
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
          {...compassProps}
          aria-label={rideCompassLabel(ride)}
          usage="走行中は、押すたびに「北が上」と「進む向きが上」を切り替えます。地図を指で動かした後は、押すと北が上に戻ります。"
          onClick={ride.onCompass}
        />
      ) : (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              {...compassProps}
              aria-label="地図の向き"
              usage="針は地図の北を指します。押すと、地図を回すダイヤルが開きます。"
            />
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

/** 走行中の方位磁針のボタンの名前。追っていない間は、押すと北が上に戻る。 */
function rideCompassLabel({ headingUp, following }: { headingUp: boolean; following: boolean }): string {
  if (headingUp) return "北を上にする（いまは進む向きが上）";
  return following ? "進む向きを上にする（いまは北が上）" : "北を上にする";
}

/** 走行モードの倍率のボタン: 押すたびに基準の倍率を中→遠→近と回す。絵は基準の倍率にいちばん近い段。 */
function RideZoomButton({ zoomBase, onNextZoom }: { zoomBase: number; onNextZoom: () => void }) {
  const step = nearestRideZoomStep(zoomBase);
  return (
    <Button
      variant="mapCtrl"
      size="mapCtrl"
      className="rounded-b-none shadow-none"
      aria-label={`縮尺（いまは${step.label}）`}
      usage={
        "押すたびに、走行中の地図の縮尺を中・遠・近の順に切り替えます。\n・2本指でつまんでも変えられます。\n・速く走るほど、選んだ縮尺より広い範囲を表示します。"
      }
      onClick={onNextZoom}
    >
      <RideZoomIcon reach={step.reach} />
    </Button>
  );
}
