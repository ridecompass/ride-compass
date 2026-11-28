"use client";

import { useEffect, useRef, useState } from "react";

import { createBaseMap } from "@/features/map/baseMap";
import { isStyleReady } from "@/features/map/layers/mapStyleOps";
import { MapLoadingBadge } from "@/features/map/MapView/MapLoadStatus";
import { applyScene } from "@/features/map/scene/applyToMap";
import { buildRideTrackScene } from "@/features/map/scene/buildScene";
import type { RideTrackLines } from "@/features/map/scene/groups/rideTrack";
import { computePathBounds } from "@/lib/routeFit";

/** 線の外に空ける幅（px）。線の端が地図の縁に付かないようにする。 */
const FIT_PADDING_PX = 24;
/** 範囲を収める前に地図を置く倍率。すぐに線の範囲へ寄せ直す。 */
const START_ZOOM = 12;

/** 走行ログで1件の走りの線を描く地図。線の範囲へ寄せて出す。線が変わったら地図を作り直す。 */
export default function RideTrackMap({ lines }: { lines: RideTrackLines }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const first = lines.find((line) => line.length > 0)?.[0];
    if (!containerRef.current || first === undefined) return;
    setLoading(true);
    const map = createBaseMap({ container: containerRef.current, center: [first[0], first[1]], zoom: START_ZOOM });
    map.once("load", () => setLoading(false));
    // 描ける前の失敗はスタイルが取れていない（`load`が来ない）ので、札を外して輪を回し続けない。
    map.on("error", () => {
      if (!isStyleReady(map)) setLoading(false);
    });
    applyScene(map, buildRideTrackScene(lines));
    const bounds = computePathBounds(lines);
    if (bounds !== null) map.fitBounds(bounds, { padding: FIT_PADDING_PX, animate: false });
    return () => map.remove();
  }, [lines]);

  return (
    <div className="relative h-72 w-full overflow-hidden rounded-md border border-[var(--color-border)]">
      <div ref={containerRef} className="size-full" aria-label="走った線の地図" role="region" />
      {loading && <MapLoadingBadge />}
    </div>
  );
}
