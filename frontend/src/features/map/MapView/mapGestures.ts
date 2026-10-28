/**
 * 地図に触れた操作が、小窓を開く「タップ」か「長押し」か、地図を動かす操作（ずらす・2本の指・ダブルタップで拡大する・流れている地図を
 * 止める）かの判断（決まりは`docs/modules/frontend/static-map-layers.md`「地図を押したときと地図の小窓」の「押したとき」）。
 *
 * 地図にもブラウザにも触れず、出来事を時刻と一緒に受け、判断の時が来たら`due`で返す。時刻は出来事の`timeStamp`と`performance.now()`
 * の同じ物差し（ms）。
 */

type Point = { readonly x: number; readonly y: number };

/** 小窓を開く操作。 */
export type MapGesture = "tap" | "longPress";

/** タップを1回のタップと確かめるまで待つ時間（ms）。この間に次の押しが来たら、ダブルタップ（地図の拡大）として開かない。MapLibre が
 * ダブルタップとみなす間（タップを数える部品の`MAX_TAP_INTERVAL`。公開の設定ではない）と同じ長さ。 */
export const TAP_CONFIRM_MS = 500;
/** 指を動かさずに押し続けて長押しとみなすまでの時間（ms）。 */
export const LONG_PRESS_MS = 500;
/** 押してから離すまでに指がこれより動いたら、地図をずらす操作。MapLibre の地図の設定`clickTolerance`の既定で、MapLibre はこれより
 * 動いた指で地図をずらす。 */
export const TAP_TOLERANCE_PX = 3;

interface Press {
  readonly start: Point;
  readonly touch: boolean;
  /** 押し始めに、利用者の操作で地図が流れていた（流れている地図を止めた）。 */
  readonly startedWhileMoving: boolean;
  /** 前のタップを確かめる間に押した（ダブルタップの2回目）。 */
  readonly second: boolean;
  /** 指を置いている間。 */
  held: boolean;
  moved: boolean;
  multi: boolean;
  longPressed: boolean;
  /** 長押しになる時刻。指1本を動かさずに置いている間だけ。 */
  longPressAt: number | null;
}

/** 1つの地図の押しの判断。押しごとに、地図を動かす操作だったかの印を持つ。 */
export class MapGestures {
  private press: Press | null = null;
  /** 確かめを待つタップの、確かめが済む時刻。 */
  private pendingTapDueAt: number | null = null;
  private userMoving = false;
  /** 指の押しのあとに来る互換のマウスの出来事を待っている間。W3C の Touch Events は、指の操作をクリックと解釈したら`touchend`のあと
   * に`mousedown`・`mouseup`・`click`をこの順に出すと決めている（時間の決まりは無い）ので、指の押しのあとの最初の`mousedown`は、
   * その押しの続きとみなす。 */
  private awaitingCompatMouse = false;

  /** 指を置いた。`fingers`は今触れている指の数（`TouchEvent.touches`）。 */
  touchStart(at: Point, fingers: number, time: number) {
    this.awaitingCompatMouse = false;
    if (this.press?.held === true || fingers > 1) {
      this.markMulti();
      return;
    }
    const press = this.startPress(at, true);
    if (!press.startedWhileMoving) press.longPressAt = time + LONG_PRESS_MS;
  }

  touchMove(at: Point, fingers: number) {
    const press = this.press;
    if (press === null || !press.held) return;
    if (fingers > 1) this.markMulti();
    if (Math.hypot(at.x - press.start.x, at.y - press.start.y) > TAP_TOLERANCE_PX) {
      press.moved = true;
      press.longPressAt = null;
    }
  }

  /** 指を離した（`touchend`・`touchcancel`）。`fingers`は残って触れている指の数で、0になったら押しが終わる。 */
  touchEnd(fingers: number) {
    const press = this.press;
    if (press === null || !press.held || fingers > 0) return;
    press.held = false;
    press.longPressAt = null;
    this.awaitingCompatMouse = true;
  }

  mouseDown(at: Point) {
    if (this.awaitingCompatMouse) {
      this.awaitingCompatMouse = false;
      return;
    }
    this.startPress(at, false);
  }

  /** 地図が利用者の操作で動き始めた。 */
  userMoveStart() {
    this.userMoving = true;
    // タップを確かめる間に地図を動かし始めたら（1回押してすぐ押したまま上下に動かす拡大等）、そのタップは開かない。
    this.pendingTapDueAt = null;
  }

  userMoveEnd() {
    this.userMoving = false;
  }

  /** 押して同じ所で離した（MapLibre の`click`）。地図を動かす操作でなければ、確かめを待つタップにして true を返す。 */
  click(time: number): boolean {
    const press = this.press;
    if (
      press !== null &&
      (press.moved || press.multi || press.startedWhileMoving || press.second || press.longPressed)
    ) {
      return false;
    }
    if (this.pendingTapDueAt !== null) {
      // 確かめる間の2回目のクリック（押しの始まりを知らせないダブルクリック）。
      this.pendingTapDueAt = null;
      return false;
    }
    this.pendingTapDueAt = time + TAP_CONFIRM_MS;
    return true;
  }

  /** マウスの右ボタンを押した（MapLibre の`contextmenu`）。長押しとして受けるなら true。指を置いている間は受けない（指の長押しは
   * `due`が数える）。 */
  contextMenu(): boolean {
    if (this.press?.touch === true && this.press.held) return false;
    this.pendingTapDueAt = null;
    if (this.press !== null) this.press.longPressed = true;
    return true;
  }

  /** 次に判断の時が来る時刻。待つものが無ければnull。 */
  nextDueAt(): number | null {
    const times = [this.pendingTapDueAt, this.press?.longPressAt].filter((t): t is number => t != null);
    return times.length === 0 ? null : Math.min(...times);
  }

  /** 時刻`now`までに判断の時が来た操作。 */
  due(now: number): MapGesture | null {
    const press = this.press;
    if (press?.longPressAt != null && now >= press.longPressAt) {
      press.longPressAt = null;
      press.longPressed = true;
      this.pendingTapDueAt = null;
      return "longPress";
    }
    if (this.pendingTapDueAt !== null && now >= this.pendingTapDueAt) {
      this.pendingTapDueAt = null;
      return "tap";
    }
    return null;
  }

  private startPress(at: Point, touch: boolean): Press {
    const second = this.pendingTapDueAt !== null;
    this.pendingTapDueAt = null;
    this.press = {
      start: at,
      touch,
      startedWhileMoving: this.userMoving,
      second,
      held: touch,
      moved: false,
      multi: false,
      longPressed: false,
      longPressAt: null,
    };
    return this.press;
  }

  private markMulti() {
    if (this.press === null) return;
    this.press.multi = true;
    this.press.longPressAt = null;
  }
}
