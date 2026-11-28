import { Button } from "@/components/ui/Button/Button";
import { VoiceOffIcon, VoiceOnIcon } from "@/components/ui/icons/lucideIcons";
import { cn } from "@/lib/cn";
import { useTranslations } from "next-intl";

interface RideVoiceButtonProps {
  on: boolean;
  onToggle: () => void;
}

/** 走行モードの間、地図の右の列に置く音声案内の入り切りのボタン。入れている間は面を強調色で塗る。 */
export default function RideVoiceButton({ on, onToggle }: RideVoiceButtonProps) {
  const t = useTranslations("ride.voice");
  return (
    <Button
      variant="mapCtrl"
      size="mapCtrl"
      onClick={onToggle}
      aria-label={t("label")}
      aria-pressed={on}
      usage={t("usage")}
      className={cn(on && "bg-[var(--color-accent)] text-white")}
    >
      {on ? <VoiceOnIcon /> : <VoiceOffIcon />}
    </Button>
  );
}
