import { TurnLeftIcon, TurnRightIcon, UTurnIcon } from "@/components/ui/icons/icons";
import type { RouteTurn } from "@/types/route";

const TURNS = {
  left: { Icon: TurnLeftIcon, label: "左折" },
  right: { Icon: TurnRightIcon, label: "右折" },
  uturn: { Icon: UTurnIcon, label: "Uターン" },
} as const;

/** 曲がる所までの道のりの書き方。1km未満は10m単位、1km以上は0.1km単位（走りながら読む桁に丸める）。 */
function formatDistance(distanceM: number): string {
  return distanceM < 1000 ? `${Math.round(distanceM / 10) * 10}m` : `${(distanceM / 1000).toFixed(1)}km`;
}

interface TurnCardProps {
  direction: RouteTurn["direction"];
  distanceM: number;
}

/** 走行モードの間、地図の上に出す次に曲がる所。向きの矢印と距離だけを出し、向きの言葉は読み上げの名前で伝える。 */
export default function TurnCard({ direction, distanceM }: TurnCardProps) {
  const { Icon, label } = TURNS[direction];
  const distance = formatDistance(distanceM);
  return (
    <div
      role="status"
      aria-label={`${distance}先で${label}`}
      className="flex items-center gap-2 rounded-[var(--radius-lg)] bg-[var(--color-accent-strong)] px-3 py-2 text-white shadow-[0_2px_10px_rgba(0,0,0,0.25)]"
    >
      <Icon size={32} />
      <span className="text-[1.5rem] leading-none font-bold tabular-nums">{distance}</span>
    </div>
  );
}
