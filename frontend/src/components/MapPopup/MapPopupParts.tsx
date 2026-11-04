"use client";

// 地図の小窓（点の吹き出し・道の小窓・区間の小窓）を組む部品。どの小窓も「上の帯」と塊（難易度の塊・施設の行）だけで組む
// ——小窓ごとに別の組み方をすると、同じ値が小窓によって違う形に見える。

import type { ReactNode } from "react";

import { PointIconSwatch } from "@/components/PointIconSwatch/PointIconSwatch";
import { legendChipsClass } from "@/components/ui/AxisLegend/axisLegend";
import { Button } from "@/components/ui/Button/Button";
import { OffRoadDistanceIcon, SelectedSpotIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import type { PointGlyph } from "@/lib/mapDisplay/legendFilter";

import { facilityPosition, type Facility } from "./facilityRows";

const hintClass = cn(textVariants({ variant: "hint" }), "m-0");

/** 小窓をつまんでずらす所（上の帯）の印。 */
export const POPUP_HANDLE_ATTRIBUTE = "data-popup-handle";

/**
 * 小窓の上の帯。つまんで小窓をずらす所で、触れても中身をスクロールせず文字を選ばない。右端は、小窓の器の右上に重なる寄せるアイコンと
 * ×（どちらも幅32px・高さ44px）の幅だけ空ける。
 */
export function PopupHeader({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      {...{ [POPUP_HANDLE_ATTRIBUTE]: "" }}
      className="flex min-h-7 min-w-0 cursor-grab touch-none items-center gap-1.5 pr-16 text-[length:var(--font-size-md)] tabular-nums select-none"
    >
      {children}
    </div>
  );
}

/** 上の帯の左の「‹ 区間」。押すと区間の小窓へ戻る。 */
export function BackToSegmentButton({ onBack }: { onBack: () => void }) {
  return (
    <Button
      variant="ghost"
      size="xs"
      className="-ml-1.5 min-h-7 flex-none text-[length:var(--font-size-sm)]"
      onClick={onBack}
      usage="選んでいる区間の小窓へ戻ります。"
    >
      ‹ 区間
    </Button>
  );
}

/** 地図の印と同じ見本。読み上げと長押しの説明に区分の名前を持たせる。 */
function KindSwatch({ color, glyph, label }: { color: string; glyph: PointGlyph; label: string }) {
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex flex-none items-center">
      <PointIconSwatch color={color} glyph={glyph} />
    </span>
  );
}

/** アイコンと値の小さな組。何の値かは読み上げと長押しの説明が持つ。 */
function IconValue({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <span title={label} className={cn(hintClass, "inline-flex flex-none items-center gap-0.5 whitespace-nowrap")}>
      <span aria-hidden="true" className="inline-flex">
        {icon}
      </span>
      <span className="sr-only">{label} </span>
      {value}
    </span>
  );
}

/** 施設を1つ1行で並べる。左から地図の印の見本・名前（名前のある施設は外の地図で探すリンク）・走行中の現在地から見たルートの前後・
 * 道からの距離。長い名前は名前の列の中で折り返す（値の位置は動かない）。走っていない間（`travelledKm`が無い）は前後を出さない。 */
export function FacilityRows({
  facilities,
  travelledKm,
}: {
  facilities: readonly Facility[];
  travelledKm: number | null;
}) {
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-[var(--color-border)] p-0 tabular-nums">
      {facilities.map((facility) => (
        <li key={facility.key} className="flex items-center gap-1.5 py-1 first:pt-0 last:pb-0">
          <KindSwatch color={facility.color} glyph={facility.glyph} label={facility.kindLabel} />
          {/* 名前は空白（「吉野家 ボートレース戸田店」の間）で折り、語の途中では1語が行に収まらないときだけ折る。 */}
          <span className="min-w-0 flex-1 break-keep [overflow-wrap:anywhere]">
            {facility.mapUrl !== null ? (
              <a
                href={facility.mapUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-usage="この施設を、別のタブの地図で開きます。"
                className="text-[var(--foreground)] underline"
              >
                {facility.name}
              </a>
            ) : (
              facility.kindLabel
            )}
            {facility.facts.map((fact) => (
              <span key={fact} className={cn(hintClass, "ml-1.5 whitespace-nowrap")}>
                {fact}
              </span>
            ))}
          </span>
          {facility.km !== null && travelledKm !== null && (
            <IconValue
              icon={<SelectedSpotIcon size={13} />}
              label="現在地から"
              value={facilityPosition(facility.km, travelledKm)}
            />
          )}
          {facility.offsetM !== null && (
            <IconValue
              icon={<OffRoadDistanceIcon size={13} />}
              label="道からの距離"
              value={`${Math.round(facility.offsetM)}m`}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

