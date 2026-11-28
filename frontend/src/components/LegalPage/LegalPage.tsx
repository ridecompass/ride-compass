import Link from "next/link";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import { APP_NAME } from "@/lib/screenNames";

/** 運営者の名乗り。名前と住所は、問い合わせの求めに応じて答える。 */
export const OPERATOR = `${APP_NAME} の運営者`;
const CONTACT_EMAIL = "h7g4bin@gmail.com";

/** 規約のページの1節。 */
export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className={cn(textVariants({ variant: "heading" }), "m-0")}>{title}</h2>
      <div className={cn(textVariants({ variant: "body" }), "flex flex-col gap-2 leading-relaxed")}>{children}</div>
    </section>
  );
}

/** 箇条書き。 */
export function LegalList({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

/** 運営者と問い合わせ先の節。 */
export function ContactSection() {
  return (
    <LegalSection title="運営者と問い合わせ">
      <p className="m-0">
        運営者は{OPERATOR}です。問い合わせは{" "}
        <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
          {CONTACT_EMAIL}
        </a>{" "}
        へ送ってください。運営者の名前と住所は、求めがあれば答えます。
      </p>
    </LegalSection>
  );
}

/** 規約のページの骨組み（見出し・版の日付・トップへ戻るリンク）。 */
export function LegalPage({ title, revised, children }: { title: string; revised: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 overflow-y-auto px-4 py-6">
      <header className="flex flex-col gap-1">
        <Link href="/" className={cn(textVariants({ variant: "hint" }), "underline")}>
          {APP_NAME} へ戻る
        </Link>
        <h1 className={cn(textVariants({ variant: "title" }), "m-0")}>{title}</h1>
        <p className={cn(textVariants({ variant: "note" }), "m-0")}>{revised} 制定</p>
      </header>
      {children}
    </main>
  );
}
