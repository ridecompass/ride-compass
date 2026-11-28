import { AppPage } from "@/components/AppPage/AppPage";
import { GuideText } from "@/components/ui/GuideText/GuideText";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import { translate } from "@/i18n/config";

/** 運営者の名乗り。名前と住所は、問い合わせの求めに応じて答える。 */
export const OPERATOR = `${translate("common.appName")} の運営者`;
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

/** 箇条書き。文だけの行は、iPhone の Safari でも句の切れ目で折る（GuideText）。 */
export function LegalList({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
      {items.map((item, index) => (
        <li key={index}>{typeof item === "string" ? <GuideText text={item} /> : item}</li>
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
    <AppPage title={title} note={`${revised} 制定`}>
      {children}
    </AppPage>
  );
}
