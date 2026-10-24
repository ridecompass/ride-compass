import { useEffect, useRef, type PointerEvent } from "react";

type PointerHandlers = {
  onPointerDown: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerMove: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerUp: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerCancel: (event: PointerEvent<SVGSVGElement>) => void;
};

/** 道のりの図の上で地点を選ぶ指（マウス）の操作。1本の指で横になぞるか押して離すと`pick`を呼ぶ。
 * **押しただけでは選ばず、途中で2本目の指が触れた操作は選択にしない**——図の上で始めたピンチ（拡大しようとした操作）で
 * 区間が選ばれ、表示が区間の詳細へ切り替わらないようにする。**縦に動き出した操作も選択にしない**——縦のなぞりは、図を
 * 載せたシート・パネルのスクロールとしてブラウザに渡す（図の上に指を置いても下へ送れる）。 */
export function useProfileGesture(): (pick: (event: PointerEvent<SVGSVGElement>) => void) => PointerHandlers {
  // 図に触れている指（ポインター）と、いまの操作に2本目が加わったか、操作の始まりの点と、動き出した向き（横は地点を選び、
  // 縦はスクロールに渡す。まだ動いていなければnull）。
  const gesture = useRef<{
    pointers: Set<number>;
    multi: boolean;
    start: { x: number; y: number };
    axis: "x" | "y" | null;
  }>({ pointers: new Set(), multi: false, start: { x: 0, y: 0 }, axis: null });
  // 画面のどこかに触れている指。2本目は図の外に触れることがあり、図のポインターだけでは数えられない
  // （タッチイベントの指の数は、図のpointermoveより後に届くので間に合わない）。
  const screenPointers = useRef<Set<number>>(new Set());
  useEffect(() => {
    const pointers = screenPointers.current;
    const down = (event: globalThis.PointerEvent) => {
      pointers.add(event.pointerId);
      if (pointers.size > 1 && gesture.current.pointers.size > 0) gesture.current.multi = true;
    };
    const up = (event: globalThis.PointerEvent) => pointers.delete(event.pointerId);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, []);

  function releasePointer(pointerId: number) {
    gesture.current.pointers.delete(pointerId);
    if (gesture.current.pointers.size === 0) {
      gesture.current.multi = false;
      gesture.current.axis = null;
    }
  }

  // 動き出した向きを、始まりの点から横と縦のどちらへ多く動いたかで1度だけ決める（同じだけなら、まだ決めない）。
  // 縦に決まった操作は、ブラウザがスクロールに取って取り消す（pointercancel）。
  function axisOf(event: PointerEvent<SVGSVGElement>): "x" | "y" | null {
    if (gesture.current.axis === null) {
      const dx = Math.abs(event.clientX - gesture.current.start.x);
      const dy = Math.abs(event.clientY - gesture.current.start.y);
      if (dx !== dy) gesture.current.axis = dx > dy ? "x" : "y";
    }
    return gesture.current.axis;
  }

  return (pick) => ({
    onPointerDown: (event) => {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      if (gesture.current.pointers.size === 0) gesture.current.start = { x: event.clientX, y: event.clientY };
      gesture.current.pointers.add(event.pointerId);
      // 画面全体の指は窓の捕捉の段で先に数えてあるので、図の上の指もそこに含まれる。
      if (screenPointers.current.size > 1) gesture.current.multi = true;
    },
    onPointerMove: (event) => {
      if (event.buttons === 0 || gesture.current.multi || !gesture.current.pointers.has(event.pointerId)) return;
      if (axisOf(event) === "x") pick(event);
    },
    onPointerUp: (event) => {
      if (!gesture.current.multi && gesture.current.pointers.has(event.pointerId) && gesture.current.axis !== "y")
        pick(event);
      releasePointer(event.pointerId);
    },
    onPointerCancel: (event) => releasePointer(event.pointerId),
  });
}
