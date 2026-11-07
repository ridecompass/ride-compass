"use client";

import { useCallback, useState } from "react";
import { readStored, writeStored } from "@/lib/safeStorage";
import { useIsomorphicLayoutEffect } from "./useIsomorphicLayoutEffect";

type StoredStateSetter<T> = (value: T | ((prev: T) => T)) => void;

// localStorageへJSONで保存し、読み込み直しても復元するuseState。`label`は保存値の画面の名前で、初期値は保存されていない
// ときにだけ使う。読めない・書けないときは`StoredValueError`を投げ、画面のエラーの境目（`app/error.tsx`）が出す。
//
// 復元はマウント後のlayout effectで読む（サーバー側の描画とハイドレーションの結果を揃える）。保存はeffectではなくsetterの
// たびに書く——effectで保存すると、StrictModeの再マウントで「復元前の初期値の保存」が割り込み、保存済みの設定を初期値で上書きする。
export function useStoredState<T>(key: string, label: string, defaultValue: T): [T, StoredStateSetter<T>] {
  const [value, setValue] = useState(defaultValue);

  useIsomorphicLayoutEffect(() => {
    setValue(readStored<T>(key, label) ?? defaultValue);
    // defaultValueは依存に入れない（呼び出し側が描画ごとに新しいリテラルを渡すため、入れると読み直しが止まらない）。
  }, [key]);

  const setStoredValue = useCallback<StoredStateSetter<T>>(
    (next) =>
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
        writeStored(key, label, resolved);
        return resolved;
      }),
    [key, label],
  );

  return [value, setStoredValue];
}
