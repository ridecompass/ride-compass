"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/Button/Button";
import { RIDE_TRACK_KEY_PREFIX } from "@/lib/rideTrack";
import { clearStoredValues } from "@/lib/safeStorage";

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 p-4 text-center">
      <h2>予期しないエラーが発生しました</h2>
      <p className="text-[var(--color-muted)]">{error.message}</p>
      {/* 端末の保存値で落ちている間は、再試行しても同じ値を読んで落ちる。全部消すと保存されていない状態から描き直せる。
          走りの位置の記録は地図の画面が読まないので落ちる元にならず、ほかに写しの無い記録なので残す。 */}
      <Button
        usage={null}
        onClick={() => {
          clearStoredValues([RIDE_TRACK_KEY_PREFIX]);
          retry();
        }}
      >
        端末に保存した値を消して再試行
      </Button>
      <Button usage={null} onClick={() => retry()}>
        再試行
      </Button>
    </div>
  );
}
