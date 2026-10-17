import { TurnLeftIcon, TurnRightIcon, UTurnIcon } from "@/components/ui/icons/icons";
import type { RouteTurn } from "@/types/route";

// 走行中の曲がる所の向きの矢印。**曲がる所のカードと地図の曲がる所の札は同じ絵**を出し、どちらを見ても同じ向きに読めるようにする。

const TURNS = {
  left: { Icon: TurnLeftIcon, label: "左折" },
  right: { Icon: TurnRightIcon, label: "右折" },
  uturn: { Icon: UTurnIcon, label: "Uターン" },
} as const satisfies Record<RouteTurn["direction"], unknown>;

/** 曲がる向きの読み上げの言葉。 */
export function turnLabel(direction: RouteTurn["direction"]): string {
  return TURNS[direction].label;
}

/** 曲がる向きの矢印。 */
export function TurnArrow({ direction, size }: { direction: RouteTurn["direction"]; size: number }) {
  const { Icon } = TURNS[direction];
  return <Icon size={size} />;
}
