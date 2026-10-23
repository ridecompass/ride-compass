"use client";

import { useMemo, useState } from "react";
import DebugConsole from "@/components/DebugConsole/DebugConsole";
import HeaderMenu from "@/components/HeaderMenu/HeaderMenu";
import { Button } from "@/components/ui/Button/Button";
import { RouteIcon } from "@/components/ui/icons/icons";
import WarningBadgeList from "@/features/conditions/WarningBadge/WarningBadge";
import WeatherPanel from "@/features/conditions/WeatherPanel/WeatherPanel";
import { useWeatherConditions, type WarningRoute } from "@/features/conditions/useWeatherConditions";
import RideBar from "@/features/ride/RideBar/RideBar";
import type { RideRemaining } from "@/features/ride/rideRemaining";
import { axisCatalogFetchFailure, useAxisCatalog } from "@/hooks/useAxisCatalog";
import { useDebugEnabled } from "@/hooks/useDebugLog";
import type { Coordinates } from "@/types/route";
import type { FetchFailure } from "@/types/fetchFailure";

interface HomeHeaderProps {
  /** 走行モードの間の走りの数字。走っていなければ null（観測のバーとメニューを出す）。 */
  ride: { remaining: RideRemaining | null; offRoute: boolean; speedKmh: number | null } | null;
  location: Coordinates;
  locationKnown: boolean;
  /** 走行モードの間に受けた現在地。走っていなければ null。 */
  ridingAt: Coordinates | null;
  /** 選んだルート（通る時刻の雷の見込みを読む）。選んでいなければ null。 */
  warningRoute: WarningRoute | null;
  locationFailure: FetchFailure | null;
  mapBearingDeg: number;
  onRedrawMap: () => void;
  onStartUsageGuide: () => void;
  /** 走行中にパネルを出しているか。 */
  panelsShown: boolean;
  onToggleRidePanel: () => void;
}

/** 常設のヘッダー（走行中は走りの帯）と、その下に開く開発者向けのログ。 */
export default function HomeHeader({
  ride,
  location,
  locationKnown,
  ridingAt,
  warningRoute,
  locationFailure,
  mapBearingDeg,
  onRedrawMap,
  onStartUsageGuide,
  panelsShown,
  onToggleRidePanel,
}: HomeHeaderProps) {
  const debugEnabled = useDebugEnabled();
  const [debugConsoleOpen, setDebugConsoleOpen] = useState(false);

  // 最寄りの実測・警報の類（位置が分かってから、位置が変わるたびに取る。仮の地点では取らない）。
  const { amedas, amedasError, gridPointToday, gridPointTodayError, warningBadgeItems, warningFetchFailures } =
    useWeatherConditions(location, locationKnown, ridingAt, warningRoute);
  const axisCatalogFailure = axisCatalogFetchFailure(useAxisCatalog());
  const headerFetchFailures = useMemo(
    () => [
      ...(locationFailure ? [locationFailure] : []),
      ...warningFetchFailures,
      ...(axisCatalogFailure ? [axisCatalogFailure] : []),
    ],
    [locationFailure, warningFetchFailures, axisCatalogFailure],
  );

  return (
    <>
      <header className="flex flex-shrink-0 flex-nowrap items-center gap-2 overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {ride !== null ? (
          <>
            <RideBar
              remaining={ride.remaining}
              offRoute={ride.offRoute}
              mapBearingDeg={mapBearingDeg}
              speedKmh={ride.speedKmh}
              wind={
                amedas?.wind_speed_ms != null && amedas.wind_direction !== null
                  ? {
                      directionDeg: amedas.wind_direction.deg,
                      directionLabel: amedas.wind_direction.label,
                      speedMs: amedas.wind_speed_ms,
                    }
                  : null
              }
            />
            <div className="ml-auto flex flex-shrink-0 items-center gap-2">
              <WarningBadgeList items={warningBadgeItems} failures={headerFetchFailures} />
              <Button
                size="panelIcon"
                onClick={onToggleRidePanel}
                aria-label="ルート"
                aria-expanded={panelsShown}
                usage="走行モードのまま「ルート設定」と「ルート結果」を開きます。候補を選び直す・作り直すと、走行モードはその候補を追います。もう一度押すと閉じます。"
              >
                <RouteIcon size={18} />
              </Button>
            </div>
          </>
        ) : (
          <>
            {/* 観測のバーは左端に固定して常に見せる。入り切らないときに隠れるのは警報の側。 */}
            <div className="left-0 flex flex-shrink-0 items-center gap-2 sticky z-1 bg-[var(--color-surface)]">
              <WeatherPanel
                amedas={amedas}
                error={amedasError}
                today={gridPointToday}
                todayError={gridPointTodayError}
                mapBearingDeg={mapBearingDeg}
              />
            </div>
            <div className="ml-auto flex flex-shrink-0 items-center gap-2">
              <WarningBadgeList items={warningBadgeItems} failures={headerFetchFailures} />
              <div className="right-0 flex items-center sticky z-1 bg-[var(--color-surface)]">
                <HeaderMenu
                  debugEnabled={debugEnabled}
                  debugConsoleOpen={debugConsoleOpen}
                  onToggleDebugConsole={() => setDebugConsoleOpen((v) => !v)}
                  onStartUsageGuide={onStartUsageGuide}
                  onRedrawMap={onRedrawMap}
                />
              </div>
            </div>
          </>
        )}
      </header>
      <DebugConsole open={debugConsoleOpen} onClose={() => setDebugConsoleOpen(false)} />
    </>
  );
}
