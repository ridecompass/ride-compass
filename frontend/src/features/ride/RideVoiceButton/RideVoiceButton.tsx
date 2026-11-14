import { Button } from "@/components/ui/Button/Button";
import { VoiceOffIcon, VoiceOnIcon } from "@/components/ui/icons/lucideIcons";
import { cn } from "@/lib/cn";

interface RideVoiceButtonProps {
  on: boolean;
  onToggle: () => void;
}

/** 走行モードの間、地図の右の列に置く音声案内の入り切りのボタン。入れている間は面を強調色で塗る。 */
export default function RideVoiceButton({ on, onToggle }: RideVoiceButtonProps) {
  return (
    <Button
      variant="mapCtrl"
      size="mapCtrl"
      onClick={onToggle}
      aria-label="音声案内"
      aria-pressed={on}
      usage="押すと、次に曲がる所の手前で向きを声で知らせます。画面を点けたまま走る間だけ読み上げます。もう一度押すと切ります。"
      className={cn(on && "bg-[var(--color-accent)] text-white")}
    >
      {on ? <VoiceOnIcon /> : <VoiceOffIcon />}
    </Button>
  );
}
