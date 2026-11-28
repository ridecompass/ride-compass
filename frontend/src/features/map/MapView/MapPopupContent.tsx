"use client";

import type { ReactNode } from "react";

import type { CostPreference } from "@/types/route";
import { BackToSegmentButton, FacilityRows, PopupHeader } from "@/components/MapPopup/MapPopupParts";
import { Button } from "@/components/ui/Button/Button";
import { ShowSectionOnMapIcon } from "@/components/ui/icons/lucideIcons";
import type { RideConditions } from "@/features/map/regionApi";
import RoadInspectorPopup from "@/features/map/MapView/RoadInspectorPopup";
import type { MapPopup, Shape } from "@/features/map/MapView/useMapPopups";

export interface MapPopupContentProps {
  /** 地図に出している小窓。 */
  popup: MapPopup;
  /** 押した物の形（寄せる先）。形が無ければnull。 */
  shape: Shape | null;
  /** 選んでいる区間の中身（ページが描く）。出さなければnullで、区間の小窓を出さない。 */
  segmentDetail: ReactNode | null;
  rideConditions: RideConditions;
  costPreference: CostPreference;
  /** 走行中の現在地の道のり（km）。施設の位置をここから見た前後で言う。走っていない間はnull。 */
  travelledKm: number | null;
  /** 点の小窓から区間の中身へ戻る。 */
  onBackToSegment: () => void;
  /** 寄せるアイコンを押したとき。押した物の形へ地図を寄せる。 */
  onFocus: (shape: Shape) => void;
}

/** 地図の小窓の中身: 右上の寄せるアイコンと、押した物ごとの中身。 */
export default function MapPopupContent({
  popup,
  shape,
  segmentDetail,
  rideConditions,
  costPreference,
  travelledKm,
  onBackToSegment,
  onFocus,
}: MapPopupContentProps) {
  return (
    // 高さに上限を付け、あふれたら中でスクロールする——地図の上の枠は、中身が伸びても画面の外へ出てはいけない。縦をスクロールに
    // すると横も切り取られるので、端に接する見本の枠（箱の1px外に描く`ring`）が欠けないよう、四辺に1pxの余白を置く。
    <div className="max-h-[min(24rem,50vh)] overflow-y-auto p-px text-[length:var(--font-size-md)] leading-[1.4]">
      {/* ×（MapLibreが本文の器の右上に置く）の左に並べる。幅を×と同じに詰め、上の帯のつまめる所を広く残す。 */}
      <div className="absolute top-0 right-8 flex">
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
