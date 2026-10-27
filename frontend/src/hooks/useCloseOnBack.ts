"use client";

import { useEffect, useRef } from "react";

/** 開いている間に積む履歴の項目の印。 */
const MARK = "__closeOnBack";

function onMarkedEntry(): boolean {
  const state: unknown = window.history.state;
  return typeof state === "object" && state !== null && MARK in state;
}

function pushMarkedEntry() {
  if (!onMarkedEntry()) window.history.pushState({ [MARK]: true }, "");
}

// 閉じて積んだ項目を戻している途中か。`history.back()`は後で popstate を起こすので、その間に開き直すと、戻り切ってから積み直す
// （先に積むと、戻りがその項目を消し、「戻る」で抜けたと読む）。
let goingBack = false;

/**
 * `open`の間、履歴に印を付けた項目を URL を変えずに1つ積み、ブラウザの「戻る」でその項目から抜けたら`onBack`を呼ぶ。
 * 「戻る」以外で閉じたとき（`open`が false になったとき）は、積んだ項目を戻して履歴に残さない。
 */
export function useCloseOnBack(open: boolean, onBack: () => void) {
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });

  useEffect(() => {
    if (!open) return;
    let waiting = goingBack;
    if (!waiting) pushMarkedEntry();
    let left = false;
    const onPop = () => {
      if (waiting) {
        waiting = false;
        pushMarkedEntry();
        return;
      }
      if (onMarkedEntry()) return;
      left = true;
      onBackRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (left || waiting || !onMarkedEntry()) return;
      goingBack = true;
      window.addEventListener("popstate", () => (goingBack = false), { once: true });
      window.history.back();
    };
  }, [open]);
}
