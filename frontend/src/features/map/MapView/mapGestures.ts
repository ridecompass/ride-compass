/**
 * 地図に触れた操作が、小窓を開く「タップ」か「長押し」か、地図を動かす操作（ずらす・2本の指・流れている地図を止める）かの判断（決まりは
 * `docs/modules/frontend/static-map-layers.md`「地図を押したときと地図の小窓」の「押したとき」）。押せる物に当たったタップは待たずに
 * 受け、何も無い所のタップは、ダブルタップの1回目でないと確かめてから受けるよう呼ぶ側に待たせる。長押しは MapLibre の`contextmenu`
 * （マウスの右ボタンと、指1本を置き続けた押し）で受ける。
 *
 * 地図にもブラウザにも時計にも触れず、MapLibre の地図の出来事を受けて、呼ぶ側がすることを返す。出来事の並びは W3C の仕様が決めるものを
 * 前提にする（Touch Events: 2本目の指は`touchstart`を出し、`touchend`の`touches`は離した指を含まず、指の操作をクリックと解釈したら
 * `touchend`のあとに`mousedown`・`mouseup`・`click`をこの順に出す。UI Events: `click`の前にはいつも`mousedown`が来る）。
 */

type Point = { readonly x: number; readonly y: number };

/** 受ける地図の出来事。`fingers`は今触れている指の数（`TouchEvent.touches`）。`hitsTarget`は押した所に押せる物があるか。
 * `byUser`は利用者の操作で動いたか（元の出来事を持つか）。 */
export type MapGestureEvent =
  | {
      readonly type: "touchstart" | "touchmove" | "touchend" | "touchcancel";
      readonly at: Point;
      readonly fingers: number;
    }
  | { readonly type: "mousedown"; readonly at: Point }
  | { readonly type: "click"; readonly hitsTarget: boolean }
  | { readonly type: "contextmenu" | "moveend" }
  | { readonly type: "movestart"; readonly byUser: boolean };

/** 呼ぶ側がすること。`tap`・`longPress`はすぐ開く。`waitTap`はダブルタップの1回目でないと確かめてから開く。 */
export type MapGestureAction = "tap" | "waitTap" | "longPress";

/** 押してから離すまでに指がこれより動いたら、地図をずらす操作。地図を作るときに MapLibre の`clickTolerance`へも渡し、MapLibre が
 * 地図をずらし始める幅と同じにする（`features/map/baseMap.ts: createBaseMap`）。 */
export const TAP_TOLERANCE_PX = 3;

interface Press {
  readonly start: Point;
  /** 指を置いている間（指の押しだけ）。 */
  held: boolean;
  /** タップにも長押しにもしない押し（ずらした・2本の指・流れている地図を止めた・長押しになった）。 */
  spent: boolean;
}

/** 1つの地図の押しの判断。 */
export class MapGestures {
  private press: Press | null = null;
  private userMoving = false;
  /** 指の押しのあとに来る互換のマウスの出来事を待っている間。指の押しのあとの最初の`mousedown`は、その押しの続き。 */
  private awaitingCompatMouse = false;

  /** 出来事を受け、呼ぶ側がすることを返す。 */
  handle(event: MapGestureEvent): MapGestureAction | null {
    const press = this.press;
    switch (event.type) {
      case "touchstart":
        this.awaitingCompatMouse = false;
        if (event.fingers > 1) this.spend();
        else this.startPress(event.at, true);
        return null;
      case "touchmove":
        if (press?.held === true && !press.spent) {
          if (Math.hypot(event.at.x - press.start.x, event.at.y - press.start.y) > TAP_TOLERANCE_PX) this.spend();
        }
        return null;
      case "touchend":
      case "touchcancel":
        // 指が0になったら押しが終わる。互換のマウスの出来事は、指を離したとき（中断でなく）だけ来る。
        if (press?.held === true && event.fingers === 0) {
          press.held = false;
          this.awaitingCompatMouse = event.type === "touchend";
        }
        return null;
      case "mousedown":
        if (this.awaitingCompatMouse) this.awaitingCompatMouse = false;
        else this.startPress(event.at, false);
        return null;
      case "movestart":
        if (event.byUser) this.userMoving = true;
        return null;
      case "moveend":
        this.userMoving = false;
        return null;
      case "click":
        if (press?.spent === true) return null;
        return event.hitsTarget ? "tap" : "waitTap";
      case "contextmenu":
        // 長押しになった押しは、離したあとのクリックをタップにしない。
        if (press?.spent === true) return null;
        this.spend();
        return "longPress";
    }
  }

  /** 押しを始める。押し始めに地図が流れていたら、流れを止めた触れで、タップにも長押しにもならない。 */
  private startPress(at: Point, held: boolean) {
    this.press = { start: at, held, spent: this.userMoving };
  }

  private spend() {
    if (this.press !== null) this.press.spent = true;
  }
}
