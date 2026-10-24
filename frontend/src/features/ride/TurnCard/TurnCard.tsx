import { TurnArrow, turnLabel } from "@/components/TurnArrow/TurnArrow";
import { formatAlongDistance } from "@/lib/geoDistance";
import type { RouteTurn } from "@/types/route";

interface TurnCardProps {
  direction: RouteTurn["direction"];
  distanceM: number;
}

/** 走行モードの間、地図の上に出す次に曲がる所。向きの矢印と距離だけを出し、向きの言葉は読み上げの名前で伝える。 */
export default function TurnCard({ direction, distanceM }: TurnCardProps) {
  const label = turnLabel(direction);
  const distance = formatAlongDistance(distanceM);
  return (
    <div
      role="status"
      aria-label={`${distance}先で${label}`}
      className="flex items-center gap-2 rounded-[var(--radius-lg)] bg-[var(--color-accent-strong)] px-3 py-2 text-white shadow-[0_2px_10px_rgba(0,0,0,0.25)]"
    >
      <TurnArrow direction={direction} size={32} />
      <span className="text-[1.5rem] leading-none font-bold tabular-nums">{distance}</span>
    </div>
  );
}
