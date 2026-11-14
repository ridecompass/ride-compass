// 1秒に何十回も変わる値（スマホの向き等）を、React の状態にせずに渡す口。状態にすると変わるたびに持ち主から下を
// 全部描き直すので、読む所だけが`subscribe`で知らせを受けて、自分で描き直す。

/** 変わり続ける値を読む口。 */
export interface LiveValue<T> {
  /** 今の値。 */
  current(): T;
  /** 値が変わったら`onChange`を呼ぶ。戻り値を呼ぶと外す。 */
  subscribe(onChange: () => void): () => void;
}

/** 値を置き、変えたら読む所へ知らせる。同じ値を置いても知らせない。 */
export function createLiveValue<T>(initial: T): LiveValue<T> & { set(value: T): void } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    current: () => value,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
