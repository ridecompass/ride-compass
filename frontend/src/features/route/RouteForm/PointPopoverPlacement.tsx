"use client";

import { type RefObject, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

import { PopoverAnchor } from "@/components/ui/Popover/Popover";
import { useVisualViewport } from "@/hooks/useVisualViewport";

const SELECTED_ROW_BUTTON = 'button[aria-pressed="true"]';

/** 地点の小窓の目印。`aboveKeyboard`の間は見えている範囲の下端（キーボードのすぐ上）の線を、ほかは選んでいる行を目印にする。 */
export function PointPopoverAnchor({
  listRef,
  aboveKeyboard,
}: {
  listRef: RefObject<HTMLOListElement | null>;
  aboveKeyboard: boolean;
}) {
  const visible = useVisualViewport(aboveKeyboard);
  // 行を目印の部品で包むと、選び直すたびに行が作り直されて押したボタンのフォーカスが外れるので、位置だけを指す。
  const selectedRow = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () =>
          listRef.current?.querySelector(SELECTED_ROW_BUTTON)?.closest("li")?.getBoundingClientRect() ?? new DOMRect(),
      },
    }),
    [listRef],
  );

  if (!aboveKeyboard) return <PopoverAnchor virtualRef={selectedRow} />;
  return createPortal(
    <PopoverAnchor asChild>
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-2 bottom-0 h-0"
        style={visible === null ? undefined : { top: visible.top + visible.height, bottom: "auto" }}
      />
    </PopoverAnchor>,
    document.body,
  );
}

/**
 * 小窓を閉じたあとのフォーカスの戻し。開いた操作を覚えておき、閉じたらそこへ戻す（欄は小窓と一緒に消えるので、戻さないと
 * フォーカスが一覧の外へ落ちる）。開いた操作が無い・消えていれば（足した経由地の行が置いた行に替わった等）、選んでいる行へ戻す。
 */
export function usePointPopoverFocus(listRef: RefObject<HTMLOListElement | null>) {
  const openerRef = useRef<HTMLElement | null>(null);
  return {
    remember: (opener: HTMLElement | null) => {
      openerRef.current = opener;
    },
    restore: (event: Event) => {
      event.preventDefault();
      const opener = openerRef.current?.isConnected ? openerRef.current : null;
      (opener ?? listRef.current?.querySelector<HTMLElement>(SELECTED_ROW_BUTTON))?.focus({ preventScroll: true });
    },
  };
}
