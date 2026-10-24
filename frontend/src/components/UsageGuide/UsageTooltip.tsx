"use client";

import { useEffect, useMemo, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent, POPOVER_COLLISION_PADDING_PX } from "@/components/ui/Popover/Popover";
import { GuideText } from "@/components/ui/GuideText/GuideText";
import { TAP_SLOP_PX } from "@/lib/tapSlop";
import { iconTargetOf, type UsageTarget } from "./usageTarget";

/** 押し続けて（マウスは重ねて）からツールチップを出すまでの時間。 */
export const LONG_PRESS_MS = 500;

/** 長押しのあと、部品へ押した扱いを届けないために止める出来事。 */
const PRESS_EVENTS = ["pointerup", "mousedown", "mouseup", "click", "contextmenu"] as const;

/**
 * アイコンだけの部品の名前と使い方を出すツールチップ。タッチ・ペンは長押しで出し、ほかを押すまで残す。
 * 長押しのあとの押し操作は、次に押すかキーを打つまで窓の捕捉段階で止める（部品の側は止め方を持たない）。
 * マウスは重ねて出し、外す・押すと消す。文字を出す部品は、名前が見えているので出さない。
 */
export default function UsageTooltip() {
  const [target, setTarget] = useState<UsageTarget | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pressStart: { x: number; y: number } | null = null;
    /** 長押しで出したあと、次に押すかキーを打つまでの間か。 */
    let swallowing = false;
    /** マウスを重ねている、アイコンだけの部品。 */
    let hovered: Element | null = null;

    const cancelTimer = () => {
      clearTimeout(timer);
      timer = undefined;
      pressStart = null;
    };
    const hide = () => {
      cancelTimer();
      hovered = null;
      setTarget(null);
    };

    const onPointerDown = (event: PointerEvent) => {
      hide();
      swallowing = false;
      if (event.pointerType === "mouse" || !(event.target instanceof Element)) return;
      const icon = iconTargetOf(event.target);
      if (icon === null) return;
      pressStart = { x: event.clientX ?? 0, y: event.clientY ?? 0 };
      timer = setTimeout(() => {
        pressStart = null;
        swallowing = true;
        setTarget(icon);
      }, LONG_PRESS_MS);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (pressStart === null) return;
      if (Math.hypot((event.clientX ?? 0) - pressStart.x, (event.clientY ?? 0) - pressStart.y) > TAP_SLOP_PX) {
        cancelTimer();
      }
    };
    const onPressEnd = (event: Event) => {
      if (pressStart !== null && event.type !== "contextmenu") cancelTimer();
      // 長押しを待つ間も、端末の長押しのメニューは出さない。
      if (swallowing || (pressStart !== null && event.type === "contextmenu")) {
        event.stopPropagation();
        event.preventDefault();
      }
    };
    // キーで押す（外付けのキーボード等）clickは、ポインタを伴わないので次の押し始めを待たずに通す。
    const onKeyDown = () => {
      swallowing = false;
    };
    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || !(event.target instanceof Element)) return;
      const icon = iconTargetOf(event.target);
      if (icon?.element === hovered) return;
      hide();
      if (icon === null) return;
      hovered = icon.element;
      timer = setTimeout(() => setTarget(icon), LONG_PRESS_MS);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || hovered === null) return;
      if (event.relatedTarget instanceof Node && hovered.contains(event.relatedTarget)) return;
      hide();
    };

    const listening = new AbortController();
    const options = { capture: true, signal: listening.signal };
    window.addEventListener("pointerdown", onPointerDown, options);
    window.addEventListener("pointermove", onPointerMove, options);
    window.addEventListener("pointercancel", cancelTimer, options);
    window.addEventListener("keydown", onKeyDown, options);
    window.addEventListener("pointerover", onPointerOver, options);
    window.addEventListener("pointerout", onPointerOut, options);
    // 部品が動くと吹き出しだけが取り残される。
    window.addEventListener("scroll", hide, options);
    for (const type of PRESS_EVENTS) window.addEventListener(type, onPressEnd, options);
    return () => {
      listening.abort();
      clearTimeout(timer);
    };
  }, []);

  const anchor = useMemo(() => ({ current: target?.element ?? null }), [target]);

  return (
    <Popover
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) setTarget(null);
      }}
    >
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        role="tooltip"
        side="top"
        layer="guide"
        tone="bare"
        collisionPadding={POPOVER_COLLISION_PADDING_PX}
        // 出しても、フォーカスは部品に置いたままにする。
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="pointer-events-none flex max-w-64 flex-col gap-0.5 rounded-md bg-[var(--foreground)] px-2.5 py-1.5 text-[length:var(--font-size-sm)] leading-[1.4] text-[var(--background)] shadow-md"
      >
        <p className="m-0 font-semibold">{target?.name}</p>
        {target?.usage && (
          <p className="m-0">
            <GuideText text={target.usage} />
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
