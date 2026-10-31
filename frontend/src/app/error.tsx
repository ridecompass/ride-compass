"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/Button/Button";

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 p-4 text-center">
      <h2>予期しないエラーが発生しました</h2>
      <p className="text-[var(--color-muted)]">
        画面の表示中に問題が発生しました。再試行しても解決しない場合は、ページを再読み込みしてください。
      </p>
      <Button usage={null} onClick={() => retry()}>
        再試行
      </Button>
    </div>
  );
}
