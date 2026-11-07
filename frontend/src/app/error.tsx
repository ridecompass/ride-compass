"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/Button/Button";
import { StoredValueError } from "@/lib/safeStorage";

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 p-4 text-center">
      <h2>予期しないエラーが発生しました</h2>
      <p className="text-[var(--color-muted)]">{error.message}</p>
      {/* 読めない・書けない保存値は、消すと保存されていない状態から描き直せる。 */}
      {error instanceof StoredValueError && (
        <Button
          usage={null}
          onClick={() => {
            error.clear();
            retry();
          }}
        >
          保存値を消して再試行
        </Button>
      )}
      <Button usage={null} onClick={() => retry()}>
        再試行
      </Button>
    </div>
  );
}
