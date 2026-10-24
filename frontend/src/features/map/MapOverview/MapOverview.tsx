"use client";

import type { Map as MapLibreMap } from "maplibre-gl";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { OverviewMapIcon } from "@/components/ui/icons/lucideIcons";
import { createBaseMap } from "@/features/map/baseMap";
import { runWhenStyleReady } from "@/features/map/layers/mapStyleOps";
import {
  OVERVIEW_SIZE_PX,
  overviewBasemapEdits,
  overviewFrameSize,
  overviewZoom,
} from "@/features/map/MapOverview/overview";
import { applyScene, weatherStateFrom, type SceneLook } from "@/features/map/scene/applyToMap";
import { buildOverviewScene } from "@/features/map/scene/buildScene";
import { viewportCenter, type MapViewport } from "@/features/map/view/mapLook";
import { useStoredBooleanState } from "@/hooks/useStoredState";

const COLLAPSED_STORAGE_KEY = "ridecompass:map-overview-collapsed";

interface MapOverviewProps {
  viewport: MapViewport;
  dynamicWeather: SceneLook["dynamicWeather"];
  /** 本体の地図を収めた要素。その大きさから、俯瞰図の上の今の画面の枠を求める。 */
  paneRef: RefObject<HTMLElement | null>;
}

/** 本体の地図の左下に添える、約60km四方の俯瞰図。本体の地図で出している気象の層を同じ色で描き、今の画面の範囲を枠で
 * 示す。「×」で丸いボタンに畳み、畳んだことは端末に覚える。出すかどうかは呼ぶ側が`overview.ts: overviewShown`で決める。 */
export default function MapOverview(props: MapOverviewProps) {
  const [collapsed, setCollapsed] = useStoredBooleanState(COLLAPSED_STORAGE_KEY, false);
  if (collapsed)
    return (
      <Button
        variant="float"
        size="iconRound"
        className="size-9"
        aria-label="俯瞰図を開く"
        usage="今の画面のまわり約60km四方の気象を、小さな地図で見ます。"
        onClick={() => setCollapsed(false)}
      >
        <OverviewMapIcon />
      </Button>
    );
  return <OverviewMap {...props} onCollapse={() => setCollapsed(true)} />;
}

function OverviewMap({ viewport, dynamicWeather, paneRef, onCollapse }: MapOverviewProps & { onCollapse: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [paneSize, setPaneSize] = useState<{ width: number; height: number } | null>(null);
  const center = viewportCenter(viewport);
  const zoom = overviewZoom(center.latitude);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = createBaseMap({
      container: containerRef.current,
      center: [center.longitude, center.latitude],
      zoom,
      inset: true,
    });
    map.setBearing(viewport.bearing);
    runWhenStyleReady(map, () => {
      const { hidden, filters } = overviewBasemapEdits(map.getStyle().layers);
      for (const layerId of hidden) map.setLayoutProperty(layerId, "visibility", "none");
      for (const [layerId, filter] of filters) map.setFilter(layerId, filter);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // 地図は1度だけ作り、範囲は下で追う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mapRef.current?.jumpTo({ center: [center.longitude, center.latitude], zoom, bearing: viewport.bearing });
  }, [center.longitude, center.latitude, zoom, viewport.bearing]);

  const scene = useMemo(() => buildOverviewScene(weatherStateFrom(dynamicWeather)), [dynamicWeather]);
  useEffect(() => {
    if (mapRef.current) applyScene(mapRef.current, scene);
  }, [scene]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const observer = new ResizeObserver(() => setPaneSize({ width: pane.clientWidth, height: pane.clientHeight }));
    observer.observe(pane);
    return () => observer.disconnect();
  }, [paneRef]);
  const frame = paneSize === null ? null : overviewFrameSize(paneSize, viewport.zoom, zoom);

  return (
    <section
      aria-label="俯瞰図"
      className="pointer-events-auto relative overflow-hidden rounded-md border border-[var(--color-border-strong)] shadow-float"
      style={{ width: OVERVIEW_SIZE_PX, height: OVERVIEW_SIZE_PX }}
    >
      <div ref={containerRef} className="size-full" />
      {frame !== null && (
        <div
          aria-hidden="true"
          data-testid="map-overview-frame"
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 border-2 border-[var(--color-accent-strong)] shadow-[0_0_0_1px_white]"
          style={{ width: frame.width, height: frame.height }}
        />
      )}
      <Button
        variant="float"
        size="bare"
        className="absolute top-1 right-1 size-6 rounded-full text-[length:var(--font-size-xs)]"
        aria-label="俯瞰図を畳む"
        usage="俯瞰図を小さな丸いボタンに畳みます。押すと戻ります。"
        onClick={onCollapse}
      >
        ✕
      </Button>
    </section>
  );
}
