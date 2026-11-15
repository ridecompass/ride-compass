import { TurnArrow, turnLabel } from "@/components/TurnArrow/TurnArrow";
import { Button } from "@/components/ui/Button/Button";
import { DarkScreenIcon, VoiceOffIcon, VoiceOnIcon } from "@/components/ui/icons/lucideIcons";
import { formatAlongDistance } from "@/lib/geoDistance";

import type { UpcomingTurn } from "../nextTurn";

// 黒の地に置く文字と縁の暗い灰色。光る所を小さくしたまま、ちらっと見て読める明るさにする。
const DIM = "text-[#666] border-[#444]";

/** 音声案内を入れている間、地図の右の列に置く、黒の画面へ入るボタン。 */
export function RideDarkScreenButton({ onEnter }: { onEnter: () => void }) {
  return (
    <Button
      variant="mapCtrl"
      size="mapCtrl"
      onClick={onEnter}
      aria-label="黒の画面"
      usage="画面を点けたまま、ほぼ黒の画面にします。位置の更新と音声案内は続きます。画面に触れると地図に戻ります。"
    >
      <DarkScreenIcon />
    </Button>
  );
}

interface RideDarkScreenProps {
  turn: UpcomingTurn | null;
  voiceOn: boolean;
  onVoiceToggle: () => void;
  onExit: () => void;
}

/**
 * 走行モードの間、画面全体を覆うほぼ黒の画面。次に曲がる所の向きと距離と、音声案内の入り切りだけを暗い灰色で出す。
 * 地図の上に重ねるだけで地図と走行モードは描いたままなので、位置の更新と読み上げは止まらない。入り切りのほかの所に触れると地図に戻る。
 */
export default function RideDarkScreen({ turn, voiceOn, onVoiceToggle, onExit }: RideDarkScreenProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="黒の画面"
      className="fixed inset-0 z-[var(--z-ride-dark)] bg-black"
    >
      <Button
        variant="ghost"
        size="bare"
        onClick={onExit}
        aria-label="地図に戻る"
        usage="地図の画面に戻ります。"
        className="absolute inset-0 rounded-none border-0 bg-black hover:enabled:bg-black"
      />
      <div className={`pointer-events-none relative flex h-full flex-col items-center justify-center gap-4 ${DIM}`}>
        {turn !== null && (
          <>
            <TurnArrow direction={turn.direction} size={120} />
            <p className="text-[2.75rem] leading-none font-bold tabular-nums">
              {formatAlongDistance(turn.distanceM)} {turnLabel(turn.direction)}
            </p>
          </>
        )}
        <Button
          variant="ghost"
          size="bare"
          onClick={onVoiceToggle}
          aria-label="音声案内"
          aria-pressed={voiceOn}
          usage="音声案内を入れる・切ります。黒の画面のままです。"
          className={`pointer-events-auto mt-12 gap-2 rounded-full border-2 bg-black px-7 py-3.5 text-[1.375rem] hover:enabled:bg-black hover:enabled:text-[#666] ${DIM}`}
        >
          {voiceOn ? <VoiceOnIcon size={24} /> : <VoiceOffIcon size={24} />}
          音声案内 {voiceOn ? "入" : "切"}
        </Button>
      </div>
    </div>
  );
}
