"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { UpcomingTurn } from "./nextTurn";
import { turnCallStage, turnCallText, type TurnCallStage } from "./turnCall";

function speak(text: string) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ja-JP";
  window.speechSynthesis.speak(utterance);
}

/**
 * 走行モードの間の音声案内。入れている間は、次に曲がる所の手前の段（`turnCall.ts`）に入るたびに向きを1回ずつ読む。
 * 既定は切で、案内を終えると切に戻る（覚えない）。iPhone の Safari は最初の読み上げを利用者の操作の中でしか始めないので、
 * 入れる操作の中で入れたことを読み、その後の読み上げを操作の外でも始められるようにする。
 */
export function useTurnVoice(navigating: boolean, turn: UpcomingTurn | null) {
  const [on, setOn] = useState(false);
  if (!navigating && on) setOn(false);
  // 最後に読んだ曲がる所（ルートの上の距離）と段。同じ所の同じ段か、近い段を読んだ後の遠い段（位置の揺れ）は読まない。
  const spoken = useRef<{ alongKm: number; stage: TurnCallStage } | null>(null);

  const stage = on && turn !== null ? turnCallStage(turn.distanceM) : null;
  useEffect(() => {
    if (turn === null || stage === null) return;
    const last = spoken.current;
    if (last !== null && last.alongKm === turn.alongKm && (last.stage === stage || last.stage === "soon")) return;
    spoken.current = { alongKm: turn.alongKm, stage };
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
    spoken.current = null;
    setOn(true);
    speak("音声案内を入れました");
  }, [on]);

  // 端末が読み上げ（Web Speech API）を持つ間だけ、入り切りを出す。
  const available = navigating && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  return { available, on, toggle };
}
