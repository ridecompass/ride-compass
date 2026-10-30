/**
 * 地図に触れた操作が、小窓を開く「タップ」か「長押し」か、地図を拡大する「ダブルタップ」か、地図を動かす操作（ずらす・2本の指・流れて
 * いる地図を止める）かの判断（決まりは`docs/modules/frontend/static-map-layers.md`「地図を押したときと地図の小窓」の「押したとき」）。
 * 押せる物に当たったタップは待たずに受け、何も無い所のタップだけ、ダブルタップの1回目でないと確かめてから受ける。
 *
 * 地図にもブラウザにも時計にも触れず、MapLibre の地図の出来事を受けて、呼ぶ側がすることを返す。待つのは呼ぶ側で、待ち終えたら
 * `confirmTap`・`confirmLongPress`で、待っていた操作がまだ生きているかを聞く。出来事の並びは W3C の仕様が決めるものを前提にする（Touch Events: 2本目の指は
 * `touchstart`を出し、指の操作をクリックと解釈したら`touchend`のあとに`mousedown`・`mouseup`・`click`をこの順に出す。UI Events:
 * `click`の前にはいつも`mousedown`が来る）。
 */

type Point = { readonly x: number; readonly y: number };

/** 受ける地図の出来事。`fingers`は今触れている指の数（MapLibre の`MapTouchEvent.points`）。`hitsTarget`は押した所に押せる物が
 * あるか。`contextmenu`はマウスの右ボタン（MapLibre の型が約束するのは右ボタンとメニューのキーだけ）。`byUser`は利用者の操作で
 * 動いたか（元の出来事を持つか）。 */
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

/** 呼ぶ側がすること。`tap`・`longPress`はすぐ開き、`doubleTap`はすぐ拡大する。`waitTap`はタップの確かめの時まで、`waitLongPress`は
 * 長押しの時まで待つ。 */
export type MapGestureAction = "tap" | "waitTap" | "doubleTap" | "waitLongPress" | "longPress";

/** 何も無い所のタップを1回のタップと確かめるまで待つ時間（ms）。この間に次の押しが来たら、ダブルタップの2回目。Android の標準の
 * ダブルタップの間（`ViewConfiguration.DOUBLE_TAP_TIMEOUT`）と同じ長さ。 */
export const DOUBLE_TAP_MS = 300;

/** 指を動かさずに置き続けて長押しとみなすまでの時間（ms）。 */
export const LONG_PRESS_MS = 500;
/** 押してから離すまでに指がこれより動いたら、地図をずらす操作。地図を作るときに MapLibre の`clickTolerance`へも渡し、MapLibre が
 * 地図をずらし始める幅と同じにする（`features/map/baseMap.ts: createBaseMap`）。 */
export const TAP_TOLERANCE_PX = 3;

interface Press {
  readonly start: Point;
  /** 指を置いている間（指の押しだけ）。 */
  held: boolean;
  /** タップにも長押しにもしない押し（ずらした・2本の指・流れている地図を止めた・長押しになった）。 */
  spent: boolean;
  /** 確かめを待つタップのあとの押しで、離すとダブルタップ。 */
  readonly second: boolean;
}

/** 1つの地図の押しの判断。 */
export class MapGestures {
  private press: Press | null = null;
  /** 確かめを待つタップがある。 */
  private tapPending = false;
  private userMoving = false;
  /** 指の押しのあとに来る互換のマウスの出来事を待っている間。指の押しのあとの最初の`mousedown`は、その押しの続き。 */
  private awaitingCompatMouse = false;

  /** 出来事を受け、呼ぶ側がすることを返す。 */
  handle(event: MapGestureEvent): MapGestureAction | null {
    const press = this.press;
    switch (event.type) {
      case "touchstart":
        this.awaitingCompatMouse = false;
        if (event.fingers > 1) {
          this.spend();
          return null;
        }
        return this.startPress(event.at, true) ? "waitLongPress" : null;
      case "touchmove":
        if (press?.held === true && !press.spent) {
          if (Math.hypot(event.at.x - press.start.x, event.at.y - press.start.y) > TAP_TOLERANCE_PX) this.spend();
        }
        return null;
      case "touchend":
      case "touchcancel":
        // `fingers`は残って触れている指の数で、0になったら押しが終わる。互換のマウスの出来事は、指を離したとき（中断でなく）だけ来る。
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
        if (press?.second === true) return "doubleTap";
        if (event.hitsTarget) return "tap";
        this.tapPending = true;
        return "waitTap";
      case "contextmenu":
        // 指を置いている間の右ボタンの出来事は受けない（指の長押しは`waitLongPress`で数える）。
        if (press?.held === true) return null;
        this.tapPending = false;
        return "longPress";
    }
  }

  /** タップの確かめの時が来た。待っていたタップがまだ生きていれば true。 */
  confirmTap(): boolean {
    const pending = this.tapPending;
    this.tapPending = false;
    return pending;
  }

  /** 長押しの時が来た。指を動かさずに置き続けていれば true（その押しはもうタップにしない）。 */
  confirmLongPress(): boolean {
    if (this.press?.held !== true || this.press.spent || this.press.second) return false;
    this.spend();
    return true;
  }

  /** 押しを始め、タップにも長押しにもなりうる押しなら true。確かめる間に押したらダブルタップの2回目、押し始めに地図が流れていたら
   * 流れを止めた触れで、どちらもならない。 */
  private startPress(at: Point, held: boolean): boolean {
    this.press = { start: at, held, spent: this.userMoving, second: this.tapPending };
    this.tapPending = false;
    return !this.press.spent && !this.press.second;
  }

  private spend() {
    if (this.press !== null) this.press.spent = true;
  }
}
