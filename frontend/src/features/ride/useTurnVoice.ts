"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { UpcomingTurn } from "./nextTurn";
import { turnCallStage, turnCallText, type TurnCallStage } from "./turnCall";

// 音を鳴らさずに読む前置き。端末は音の出口を黙っている間に休ませ、起こす間の頭の音を落とす（ほかのアプリの音を下げる間も同じ）ので、
// 落ちてよい無音を先に読んで出口を起こし、すぐ続けて本文を読む。
const WAKE_TEXT = "音声案内";

function utter(text: string, volume: number) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ja-JP";
  utterance.volume = volume;
  window.speechSynthesis.speak(utterance);
}

function speak(text: string) {
  utter(WAKE_TEXT, 0);
  utter(text, 1);
}

/**
 * 走行モードの間の音声案内。入れている間は、次に曲がる所を初めて知ったときと、その手前の段（`turnCall.ts`）に入るたびに
 * 向きを1回ずつ読み、ルートを外れた・戻ったことを読む。
 * 既定は切で、案内を終えると切に戻る（覚えない）。iPhone の Safari は最初の読み上げを利用者の操作の中でしか始めないので、
 * 入れる操作の中で入れたことを読み、その後の読み上げを操作の外でも始められるようにする。
 */
export function useTurnVoice(navigating: boolean, turn: UpcomingTurn | null, offRoute: boolean) {
  const [on, setOn] = useState(false);
  if (!navigating && on) setOn(false);
  // 曲がる所（ルートの上の距離）ごとに、読んだうちでいちばん近い段。同じ段か、近い段を読んだ後の遠い段（位置の揺れ）は読まない。
  const spoken = useRef(new Map<number, TurnCallStage>());
  // 最後に知った、ルートを外れているか。切っている間も追い、入れたときの状態を外れた・戻ったと読まない。
  const wasOffRoute = useRef(offRoute);

  useEffect(() => {
    if (wasOffRoute.current === offRoute) return;
    wasOffRoute.current = offRoute;
    if (on) speak(offRoute ? "ルートを外れました" : "ルートに戻りました");
  }, [on, offRoute]);

  const stage = on && turn !== null ? turnCallStage(turn.distanceM) : null;
  useEffect(() => {
    if (turn === null || stage === null) return;
    const last = spoken.current.get(turn.alongKm);
    if (last !== undefined && last >= stage) return;
    spoken.current.set(turn.alongKm, stage);
    speak(turnCallText(stage, turn.direction, turn.distanceM));
  }, [turn, stage]);

  // 切ったら、読んでいる途中のものと待ちの列を捨てる。
  useEffect(() => {
    if (!on) return;
    return () => window.speechSynthesis.cancel();
  }, [on]);

  const toggle = useCallback(() => {
    if (on) {
      setOn(false);
      return;
    }
    spoken.current = new Map();
    setOn(true);
    speak("音声案内を入れました");
  }, [on]);

  // 端末が読み上げ（Web Speech API）を持つ間だけ、入り切りを出す。
  const available = navigating && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  return { available, on, toggle };
}
