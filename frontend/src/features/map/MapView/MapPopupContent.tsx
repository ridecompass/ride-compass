"use client";

import type { ReactNode } from "react";

import type { CostPreference } from "@/types/route";
import { BackToSegmentButton, FacilityRows, PopupHeader } from "@/components/MapPopup/MapPopupParts";
import { Button, buttonVariants } from "@/components/ui/Button/Button";
import { ShowSectionOnMapIcon, StreetViewIcon } from "@/components/ui/icons/lucideIcons";
import { nearerSide, nearestEdge } from "@/lib/localPlane";
import { streetViewUrl } from "@/lib/streetViewUrl";
import { cn } from "@/lib/cn";
import type { RideConditions } from "@/features/map/regionApi";
import RoadInspectorPopup from "@/features/map/MapView/RoadInspectorPopup";
import type { MapPopup, PopupTarget, Shape } from "@/features/map/MapView/useMapPopups";

/** 押した道がルートと重なるとみる、道の上で押した所に最も近い点とルートの線の隔たりの上限（m）。ルートは道の線をつないだ形なので
 * 重なる道ではほぼ0になり、並んで走る別の道を重なるとみないよう小さく取る。 */
const ROUTE_OVERLAP_M = 5;

/**
 * 小窓の地点で見る向き（真北0・時計回りの度。nullなら Google に任せる）。押した物の線のうち地点に最も近い辺の向きを、進む向きへ
 * 向ける。区間はルートの一部で、線の向きがそのまま進む向き。道は両向きに走れるので、辺の両向きのうち、押した道がルートと重なれば
 * ルートの進む向きに、重ならず走行中なら今の進む向きに近い側。点は線を持たない（束ねた点の形は点の並びで、道筋ではない）。
 */
function lookingOf(
  popup: MapPopup,
  { lngLat, shape }: PopupTarget,
  routePath: Shape | null,
  travelBearing: number | null,
): number | null {
  if (popup.kind === "point" || shape === null) return null;
  const along = nearestEdge(shape, lngLat);
  if (along === null || popup.kind === "segment") return along?.bearing ?? null;
  const onRoute = routePath === null ? null : nearestEdge(routePath, along.point);
  const forward = onRoute !== null && onRoute.offsetM <= ROUTE_OVERLAP_M ? onRoute.bearing : travelBearing;
  return forward === null ? null : nearerSide(along.bearing, forward);
}

export interface MapPopupContentProps {
  /** 地図に出している小窓。 */
  popup: MapPopup;
  target: PopupTarget;
  /** 選んでいる区間の中身（ページが描く）。出さなければnullで、区間の小窓を出さない。 */
  segmentDetail: ReactNode | null;
  /** 選んでいるルートの線。選んでいなければnull。 */
  routePath: Shape | null;
  /** 走行中の今の進む向き（真北0・時計回りの度）。走っていない・まだ分からなければnull。 */
  travelBearing: number | null;
  rideConditions: RideConditions;
  costPreference: CostPreference;
  /** 走行中の現在地の道のり（km）。施設の位置をここから見た前後で言う。走っていない間はnull。 */
  travelledKm: number | null;
  /** 点の小窓から区間の中身へ戻る。 */
  onBackToSegment: () => void;
  /** 寄せるアイコンを押したとき。押した物の形へ地図を寄せる。 */
  onFocus: (shape: Shape) => void;
}

/** 地図の小窓の中身: 右上の Street View のリンクと寄せるアイコン、押した物ごとの中身。 */
export default function MapPopupContent({
  popup,
  target,
  segmentDetail,
  routePath,
  travelBearing,
  rideConditions,
  costPreference,
  travelledKm,
  onBackToSegment,
  onFocus,
}: MapPopupContentProps) {
  const { lngLat, shape } = target;
  return (
    // 高さに上限を付け、あふれたら中でスクロールする——地図の上の枠は、中身が伸びても画面の外へ出てはいけない。縦をスクロールに
    // すると横も切り取られるので、端に接する見本の枠（箱の1px外に描く`ring`）が欠けないよう、四辺に1pxの余白を置く。
    <div className="max-h-[min(24rem,50vh)] overflow-y-auto p-px text-[length:var(--font-size-md)] leading-[1.4]">
      {/* ×（MapLibreが本文の器の右上に置く）の左に並べる。幅を×と同じに詰め、上の帯のつまめる所を広く残す。 */}
      <div className="absolute top-0 right-8 flex">
        {/* 開く先は地点だけで決まるので、押す前に決まったリンクにする（押してから開くと、iPhone の Safari が新しい窓を止める）。 */}
        <a
          href={streetViewUrl(lngLat, lookingOf(popup, target, routePath, travelBearing))}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="ここのストリートビューを開く"
          data-usage="この小窓の地点の Street View を、別のタブの Google マップで開きます。"
          className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-11")}
        >
          <StreetViewIcon size={18} />
        </a>
        {shape !== null && shape.length > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="h-11"
            aria-label="地図をここへ寄せる"
            usage="地図を動かして、この小窓の道や地点を画面に収めます。道や地点を押して小窓を開いただけでは、地図は動きません。"
            onClick={() => onFocus(shape)}
          >
            <ShowSectionOnMapIcon size={18} />
          </Button>
        )}
      </div>
      {popup.kind === "road" ? (
        <RoadInspectorPopup
          properties={popup.properties}
          track={popup.track}
          conditions={{
            ...rideConditions,
            ...popup.tile,
          }}
          costPreference={costPreference}
        />
      ) : popup.kind === "segment" ? (
        segmentDetail
      ) : (
        <PointContent popup={popup} travelledKm={travelledKm} onBack={onBackToSegment} />
      )}
    </div>
  );
}

/** 点の中身: 施設の行。区間を選んでいる間に開いたなら、上の帯に区間の中身へ戻る操作を置く。 */
function PointContent({
  popup,
  travelledKm,
  onBack,
}: {
  popup: Extract<MapPopup, { kind: "point" }>;
  travelledKm: number | null;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <PopupHeader label="点の小窓の上の帯">
        {popup.segment !== null && <BackToSegmentButton onBack={onBack} />}
      </PopupHeader>
      <FacilityRows facilities={popup.facilities} travelledKm={travelledKm} />
    </div>
  );
}
