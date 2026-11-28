import Link from "next/link";

import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import { APP_NAME } from "@/lib/screenNames";

/** 地図の画面の外に開くページの骨組み（トップへ戻るリンク・見出し）。`note`は見出しの下の小さな補足。 */
export function AppPage({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 overflow-y-auto px-4 py-6">
      <header className="flex flex-col gap-1">
        <Link href="/" className={cn(textVariants({ variant: "hint" }), "underline")}>
          {APP_NAME} へ戻る
        </Link>
        <h1 className={cn(textVariants({ variant: "title" }), "m-0")}>{title}</h1>
        {note !== undefined && <p className={cn(textVariants({ variant: "note" }), "m-0")}>{note}</p>}
      </header>
      {children}
    </main>
  );
}
