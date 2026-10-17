"use client";

import { Button } from "@/components/ui/Button/Button";
import { BackToNowIcon } from "@/components/ui/icons/icons";
import Ruler, { type RulerFrame } from "@/components/ui/Ruler/Ruler";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import { cardVariants } from "@/components/ui/Card/Card";

interface DynamicLayerTimeSliderProps {
  /** コマの`label`は日付付きの日時（目盛りの文字は日付を持たないので、日付をまたぐ曖昧さはこれが解く）。 */
  frames: readonly RulerFrame[];
  /** framesの添字（framesは1コマ以上）。 */
  index: number;
  onIndexChange: (index: number) => void;
  /** 「今」にあたる添字。「現在」ボタンを押せなくする判定にだけ使う。 */
  currentIndex: number;
  /** 「現在」ボタン。`currentIndex`へは飛ばない（目盛りへ丸めた近似で、実時刻より粗い）。 */
  onNow: () => void;
  ariaLabel: string;
}

/** 出発時刻を選ぶルーラーと、1コマ送り・現在へ戻すボタン。時刻の計算は知らない（コマの並びは呼ぶ側が作る）。 */
export default function DynamicLayerTimeSlider({
  frames,
  index,
  onIndexChange,
  currentIndex,
  onNow,
  ariaLabel,
}: DynamicLayerTimeSliderProps) {
  // 端では押せないので、動かした先は必ず範囲の中。
  const stepIndex = (delta: number) => onIndexChange(index + delta);

  const frame = frames[index];

  return (
    <div className="pointer-events-none">
      <div
        className={cn(
          cardVariants({ variant: "float" }),
          "flex w-[min(90vw,26rem)] max-w-[min(26rem,100%)] flex-col gap-1 rounded-sm px-2 py-1.5",
        )}
      >
        <div className={cn(textVariants({ variant: "heading" }), "pointer-events-auto touch-none tabular-nums")}>
          {frame.label}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="stepper"
            size="sm"
            className="pointer-events-auto touch-none"
            onClick={() => stepIndex(-1)}
            disabled={index <= 0}
            aria-label={`${ariaLabel}を1つ前へ`}
            title="1つ前へ"
          >
            ‹
          </Button>
          <Ruler
            frames={frames}
            index={index}
            onIndexChange={onIndexChange}
            ariaLabel={ariaLabel}
            className="pointer-events-auto min-w-30 flex-1 touch-none"
          />
          <Button
            variant="stepper"
            size="sm"
            className="pointer-events-auto touch-none"
            onClick={() => stepIndex(1)}
            disabled={index >= frames.length - 1}
            aria-label={`${ariaLabel}を1つ次へ`}
            title="1つ次へ"
          >
            ›
          </Button>
          <Button
            variant="stepper"
            size="sm"
            className="pointer-events-auto touch-none"
            onClick={onNow}
            disabled={index === currentIndex}
            aria-label={`${ariaLabel}を現在に戻す`}
            usage="送った時刻を、いまの時刻に戻します。"
          >
            <BackToNowIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}
