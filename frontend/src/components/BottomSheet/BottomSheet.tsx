"use client";

import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { textVariants } from "@/components/ui/Text/Text";
import { useStoredState } from "@/hooks/useStoredState";
import { cn } from "@/lib/cn";
import { mapOverlayEdge } from "@/lib/mapOverlayEdges";
import { TAP_SLOP_PX } from "@/lib/tapSlop";

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** 見出し（シートのアクセシブル名にもなる）。 */
  title: string;
  /** 見出しの行の右、閉じるボタンの手前に置く操作。 */
  headerAction: React.ReactNode;
  /** 見出しのすぐ右に置くもの（中身を切り替えるタブ等、右の操作と役割が違うもの）。 */
  headerLead?: React.ReactNode;
  children: React.ReactNode;
  /** 利用者が決めた高さ（vh）。nullなら開くたびに中身へ合わせる。 */
  chosenHeightVh: number | null;
  /** 帯の操作を終えたときだけ呼ばれる（ドラッグの途中の高さはシートの中だけで持つ）。 */
  onHeightChoose: (vh: number) => void;
  /** 変わったら中身が別物になったとみなして高さを合わせ直す（タブの切り替え等）。 */
  fitKey?: string;
}

const SWIPE_CLOSE_THRESHOLD_PX = 60;

// 上限は地図を隠し切らない高さにする。
const MIN_SHEET_HEIGHT_VH = 20;
const MAX_SHEET_HEIGHT_VH = 80;
export const DEFAULT_SHEET_HEIGHT_VH = 50;
const HEIGHT_KEY_STEP_VH = 5;

export function clampSheetHeightVh(vh: number): number {
  return Math.min(MAX_SHEET_HEIGHT_VH, Math.max(MIN_SHEET_HEIGHT_VH, vh));
}

// シートは1つずつしか開かないため、1つの値を共有する。
const CHOSEN_HEIGHT_STORAGE_KEY = "ridecompass:mobile-sheet-height-vh";

/** 利用者が帯で決めた高さ（vh。決めていなければnull）と、決める関数。保存値があることが「決めた」印で、決めた後は
 * 中身に合わせるのをやめる。 */
export function useChosenSheetHeight(): [number | null, (vh: number) => void] {
  return useStoredState<number | null>(CHOSEN_HEIGHT_STORAGE_KEY, null, {
    serialize: JSON.stringify,
    deserialize: (raw) => {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "number" && Number.isFinite(parsed) ? clampSheetHeightVh(parsed) : null;
    },
  });
}

/** 中身がそのまま並んだときの高さ。高さの指定を一時的に外して測る（`scrollHeight`や子の合算は、中身が箱より
 * 低いと箱の高さを返すので縮める判断に使えない）。読み書きは同じレイアウトの中で終わるので途中の高さは描かれない。 */
function naturalHeightOf(sheet: HTMLElement): number {
  const specified = sheet.style.height;
  sheet.style.height = "auto";
  const natural = sheet.getBoundingClientRect().height;
  sheet.style.height = specified;
  return natural;
}

/** シートの中の要素に付けると、開いたときに合わせる高さをその要素の下端までにする印（中身の全部ではなく、狭い高さで
 * 先に見せたい所までを開く）。中身がそこより短ければ中身の高さに合わせる。 */
export const SHEET_FIT_END_ATTRIBUTE = "data-sheet-fit-end";

/** 開いたときに合わせる高さ。印の要素があれば、その下端に本文の下の余白を足した高さと中身の高さの低い方。 */
function fitHeightOf(sheet: HTMLElement, body: HTMLElement): number {
  const natural = naturalHeightOf(sheet);
  const end = sheet.querySelector(`[${SHEET_FIT_END_ATTRIBUTE}]`);
  if (!end) return natural;
  const toEnd =
    end.getBoundingClientRect().bottom -
    sheet.getBoundingClientRect().top +
    (parseFloat(getComputedStyle(body).paddingBottom) || 0);
  return Math.min(natural, toEnd);
}

/** モバイルの下からせり上がるシート。暗幕を敷かず、シートの外を押しても閉じない（開いたまま地図を動かせる）。
 * 閉じるのは✕・下スワイプ・呼ぶ側のタブの押し直し。 */
export default function BottomSheet({ open, ...props }: BottomSheetProps) {
  // 開くたびに作り直し、前に開いたときの途中の高さを持ち越さない。
  return open ? <OpenBottomSheet {...props} /> : null;
}

function OpenBottomSheet({
  onClose,
  title,
  headerAction,
  headerLead,
  children,
  chosenHeightVh,
  onHeightChoose,
  fitKey,
}: Omit<BottomSheetProps, "open">) {
  const titleId = useId();
  // 中身に合わせた高さ・ドラッグの途中の高さ。持ち主へ上げないので、動かす間に持ち主は描き直されない。
  const [workingHeightVh, setWorkingHeightVh] = useState<number | null>(null);
  const heightVh = workingHeightVh ?? chosenHeightVh ?? DEFAULT_SHEET_HEIGHT_VH;
  const autoFitHeight = chosenHeightVh === null;
  const sheetRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // 開いたときの中身に合う高さ（印があればその下端まで）へ合わせる（高すぎると空白で地図を隠す）。開いている間は合わせ直さない（候補や区間を
  // 押すたびに地図の見える範囲が動かないように）。実寸が取れない環境では何もしない。
  useLayoutEffect(() => {
    if (!autoFitHeight) return;
    const sheet = sheetRef.current;
    const body = bodyRef.current;
    if (!sheet || !body) return;
    const viewportHeight = window.innerHeight;
    const needed = fitHeightOf(sheet, body);
    if (viewportHeight <= 0 || sheet.clientHeight <= 0 || needed <= 0) return;
    const fittedVh = clampSheetHeightVh(Math.ceil((needed / viewportHeight) * 100));
    // 描き直しを待たずに書く。同じ描画で開いた他の部品の effect（地図がルートを空きへ収める等）は、描き直しの前に流れて
    // シートの高さを読む。
    sheet.style.height = `${fittedVh}vh`;
    setWorkingHeightVh(fittedVh);
  }, [autoFitHeight, fitKey]);
  // つまみのドラッグ。始めた指（pointerId）の動きだけを見る（別の指のmove/upに反応しない）。
  // つまむ前のシートの中の高さ（`startWorkingHeightVh`）は、決めずに終えたときに戻す先。
  const dragRef = useRef<{
    pointerId: number;
    startClientY: number;
    startHeightVh: number;
    startWorkingHeightVh: number | null;
  } | null>(null);

  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    // シートの中から開いた窓（Radix）は、捕捉の段で受けたEscで自分を閉じて既定の動きを止める。そのEscでシートまで閉じない。
    if (e.key === "Escape" && !e.defaultPrevented) onClose();
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => handleKeyDown(e);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  function handleTouchStart(e: React.TouchEvent) {
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  }

  function handleTouchEnd(e: React.TouchEvent) {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start) return;
    const touch = e.changedTouches[0];
    const dy = touch.clientY - start.y;
    const dx = touch.clientX - start.x;
    // 縦の下スワイプだけで閉じる（横の動きが大きいのはシート内の横スクロールの操作）。
    if (dy > SWIPE_CLOSE_THRESHOLD_PX && Math.abs(dy) > Math.abs(dx)) {
      onClose();
    }
  }

  function handleHandlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = {
      pointerId: e.pointerId,
      startClientY: e.clientY,
      startHeightVh: heightVh,
      startWorkingHeightVh: workingHeightVh,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  /** つまんだ指が今の位置にあるときの高さ。 */
  function draggedHeightVh(drag: NonNullable<typeof dragRef.current>, clientY: number): number {
    return clampSheetHeightVh(drag.startHeightVh + ((drag.startClientY - clientY) / window.innerHeight) * 100);
  }

  function handleHandlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    setWorkingHeightVh(draggedHeightVh(drag, e.clientY));
  }

  // 離した位置から決める（最後の動きの描き直しが済む前に離しが届くことがある）。動かさずに離したなら決めない——決めると
  // 開くたびに中身へ合わせるのが止まる。
  function handleHandlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    if (Math.abs(e.clientY - drag.startClientY) <= TAP_SLOP_PX) setWorkingHeightVh(drag.startWorkingHeightVh);
    else choose(draggedHeightVh(drag, e.clientY));
  }

  // 端末がつまみの操作を取り上げた（OSのジェスチャー等）ら、つまむ前の高さへ戻す。
  function handleHandlePointerCancel(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    setWorkingHeightVh(drag.startWorkingHeightVh);
  }

  function choose(vh: number) {
    onHeightChoose(vh);
    setWorkingHeightVh(null);
  }

  function handleHandleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const direction = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
    if (direction === 0) return;
    e.preventDefault();
    choose(clampSheetHeightVh(heightVh + direction * HEIGHT_KEY_STEP_VH));
  }

  return (
    // app-bottom-sheetはglobals.cssのモバイル向けの規則（シート内の入力欄・チェックボックスを大きくする）の目印。
    <div
      ref={sheetRef}
      className="app-bottom-sheet fixed right-0 bottom-[var(--mobile-tabbar-height)] left-0 z-[var(--z-bottom-sheet)] flex flex-col rounded-t-lg bg-[var(--background)] shadow-[0_-2px_16px_rgba(0,0,0,0.3)]"
      role="dialog"
      aria-labelledby={titleId}
      {...mapOverlayEdge("bottom")}
      style={{ height: `${heightVh}vh` }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* 高さを変える帯。全幅の帯は小さいボタンより押し外しにくいため、縦は44pxより薄くして地図を空ける。 */}
      <div
        className="flex w-full flex-shrink-0 cursor-ns-resize touch-none items-center justify-center py-2.5 before:h-1 before:w-9 before:rounded-sm before:bg-[var(--color-border-strong)] before:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
        role="separator"
        aria-orientation="horizontal"
        aria-label="パネルの高さを変更"
        aria-valuenow={Math.round(heightVh)}
        aria-valuemin={MIN_SHEET_HEIGHT_VH}
        aria-valuemax={MAX_SHEET_HEIGHT_VH}
        tabIndex={0}
        onPointerDown={handleHandlePointerDown}
        onPointerMove={handleHandlePointerMove}
        onPointerUp={handleHandlePointerUp}
        onPointerCancel={handleHandlePointerCancel}
        // つまみのtouchstartがシートの下スワイプの判定まで届くと、ドラッグの後の指離しで閉じてしまう。
        onTouchStart={(e) => e.stopPropagation()}
        onKeyDown={handleHandleKeyDown}
      />
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-[var(--color-border)] px-3">
        {/* 見出しの横に収まらなければ、見出しのすぐ右に置くものを見出しの下の行へ折り返す（右の操作はその右に残る）。 */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
          <h2
            id={titleId}
            tabIndex={-1}
            className={cn(textVariants({ variant: "heading" }), "min-w-0 truncate focus:outline-none")}
          >
            {title}
          </h2>
          {headerLead && <div className="flex min-w-0 items-center">{headerLead}</div>}
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {headerAction}
          <Button
            usage="シートを閉じて、地図を広く見せます。下のタブを押すと、また開きます。"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="閉じる"
            className="size-7 text-base text-[var(--foreground)]"
          >
            ✕
          </Button>
        </div>
      </div>
      {/* 本文のスクロールが下スワイプの判定まで届かないようにする（届くとスクロールしただけで閉じる）。 */}
      <div
        ref={bodyRef}
        className="flex flex-col gap-2 overflow-y-auto px-3 pt-2 pb-3"
        onTouchStart={(e) => e.stopPropagation()}
        onTouchEnd={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
