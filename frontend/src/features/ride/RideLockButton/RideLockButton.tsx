"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { cardVariants } from "@/components/ui/Card/Card";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/Popover/Popover";
import { MapLockedIcon, MapUnlockedIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

import { NOTICE_CARD } from "../RideModeButton/RideModeButton";

/** ロックの間に鍵を押して出した「ロックを外す」を、選ばなければ閉じるまでの時間（ms）。 */
export const UNLOCK_CHOICE_MS = 5_000;

interface RideLockButtonProps {
  locked: boolean;
  onLock: () => void;
  onUnlock: () => void;
}

/** 走行モードの間、地図の右の列の走行モードのボタンの下に置く鍵のボタン。外れている間に押すと、地図への触れを受け付けないロックにし、
 * ロックの間は横に札を出す。ロックの間に押すと横に「ロックを外す」を出し、それを押すと外す——離れた2か所を順に押させ、雨粒が
 * 続けて当たっても外れないようにする。選ばなければ時間で閉じる。 */
export default function RideLockButton({ locked, onLock, onUnlock }: RideLockButtonProps) {
  const [choosing, setChoosing] = useState(false);
  if (!locked && choosing) setChoosing(false);
  useEffect(() => {
    if (!choosing) return;
    const timer = setTimeout(() => setChoosing(false), UNLOCK_CHOICE_MS);
    return () => clearTimeout(timer);
  }, [choosing]);

  return (
    <div className="relative flex">
      <Popover open={choosing} onOpenChange={setChoosing}>
        <PopoverAnchor asChild>
          <Button
            variant="mapCtrl"
            size="mapCtrl"
            onClick={() => (locked ? setChoosing((open) => !open) : onLock())}
            aria-label="ロック"
            aria-pressed={locked}
            aria-haspopup={locked ? "dialog" : undefined}
            aria-expanded={locked ? choosing : undefined}
            usage="押すと地図への触れを受け付けないロックにし、雨粒が画面に当たっても地図は動かず、現在地を追い続けます。右の列のボタンと地図の下の部品は、ロックの間も使えます。ロックの間に押すと横に「ロックを外す」が出て、それを押すと外れます。"
            className={cn(locked && "bg-[var(--color-accent)] text-white")}
          >
            {locked ? <MapLockedIcon /> : <MapUnlockedIcon />}
          </Button>
        </PopoverAnchor>
        <PopoverContent side="left" align="start" aria-label="ロックの外し方" className="flex flex-col gap-1.5">
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              setChoosing(false);
              onUnlock();
            }}
            usage="ロックを外し、地図を指で動かせるようにします。"
          >
            ロックを外す
          </Button>
          <p className={cn(textVariants({ variant: "hint" }), "text-center")}>{UNLOCK_CHOICE_MS / 1000}秒で閉じます</p>
        </PopoverContent>
      </Popover>
      {locked && !choosing && (
        <p
          className={cn(
            cardVariants({ variant: "float" }),
            textVariants({ variant: "hint" }),
            "pointer-events-none",
            NOTICE_CARD,
          )}
        >
          ロック中: 地図は触っても動きません
        </p>
      )}
    </div>
  );
}
