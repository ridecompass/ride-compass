"use client";

import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/apiError";

/** コピー完了の表示を戻すまでの時間。 */
const COPIED_RESET_MS = 2000;

function describeFailure(err: unknown): string {
  return `クリップボードへコピーできませんでした（httpsまたはlocalhostでのみ利用できます）: ${errorMessage(err)}`;
}

/** クリップボードへの書き込みと、その結果表示（コピー済み・失敗）をまとめて持つ。
 *
 * Clipboard APIは[SecureContext]のため、httpのIPアクセス等では`navigator.clipboard`自体が
 * undefinedになる。`.catch()`はPromiseの拒否しか捕まえないので、プロパティアクセスの同期
 * TypeErrorをtryで受けないとボタンが無反応のままになる。権限拒否も握り潰さない——
 * 押しても何も起きないだけの状態を作らないため。
 */
export function useCopyToClipboard(): {
  copied: boolean;
  error: string | null;
  copy: (text: string) => void;
} {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // アンマウント後にsetCopiedが走らないよう保持してクリーンアップする。
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  // 失敗したら前のコピーの「コピー済み」も消す（残すと、失敗の文と並んで成功したように見える）。
  const fail = (err: unknown) => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setCopied(false);
    setError(describeFailure(err));
  };

  const copy = (text: string) => {
    setError(null);
    try {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(true);
          if (timerRef.current !== null) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
        })
        .catch(fail);
    } catch (err) {
      fail(err);
    }
  };

  return { copied, error, copy };
}
