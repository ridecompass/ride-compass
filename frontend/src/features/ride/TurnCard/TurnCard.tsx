import { TurnArrow, turnLabel } from "@/components/TurnArrow/TurnArrow";
import { formatAlongDistance } from "@/lib/geoDistance";
import type { TurnShape } from "@/components/TurnArrow/turnShape";
import type { RouteTurn } from "@/types/route";
import { useTranslations } from "next-intl";

interface TurnCardProps {
  direction: RouteTurn["direction"];
  distanceM: number;
  shape: TurnShape;
}

/** 走行モードの間、地図の上に出す次に曲がる所。曲がる所の絵と距離だけを出し、向きの言葉は読み上げの名前で伝える。 */
export default function TurnCard({ direction, distanceM, shape }: TurnCardProps) {
  const t = useTranslations("ride");
  const label = turnLabel(direction);
  const distance = formatAlongDistance(distanceM);
  return (
    <div
      role="status"
      aria-label={t("turnCard", { distance, label })}
      className="flex items-center gap-2 rounded-[var(--radius-lg)] bg-[var(--color-accent-strong)] px-3 py-2 text-white shadow-[0_2px_10px_rgba(0,0,0,0.25)]"
    >
      <TurnArrow shape={shape} size={52} />
      <span className="text-[1.5rem] leading-none font-bold tabular-nums">{distance}</span>
    </div>
  );
}
