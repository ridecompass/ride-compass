import Link from "next/link";
import type { Metadata } from "next";

import { ContactSection, LegalList, LegalPage, LegalSection, OPERATOR } from "@/components/LegalPage/LegalPage";
import { APP_NAME } from "@/lib/screenNames";

export const metadata: Metadata = { title: `利用規約 | ${APP_NAME}` };

export default function TermsPage() {
  return (
    <LegalPage title="利用規約" revised="2026-11-28">
      <p className="m-0">
        この規約は、{OPERATOR}（以下「運営者」）が提供する {APP_NAME}
        （自転車で走る周回ルートを作るアプリ）の使い方を決めます。アプリを使うには、Google でログインし、この規約と
        <Link href="/privacy" className="underline">
          プライバシーポリシー
        </Link>
        に同意してもらいます。アプリを使うことは、走行モードで走った走りを送って走行ログに残すことへの同意になります。
      </p>

      <LegalSection title="走りを走行ログに残すこと">
        <LegalList
          items={[
            "アプリを使うには、Google でログインし、今の版のこの規約とプライバシーポリシーに同意します。同意しないで使うことはできません。",
            "走行モードで走った走りは、走り終えたときに毎回送り、あなたの走行ログに残します。集めるもの・使い道・持たないもの・消し方は、プライバシーポリシーに書いています。",
            "同意をやめると、アプリを使えなくなります。",
            "規約の版を上げたときは、次にアプリを開いたときに、もう一度同意を聞きます。",
          ]}
        />
      </LegalSection>

      <LegalSection title="走るときの注意">
        <LegalList
          items={[
            "ルート・天気・道の情報は参考です。実際の道の状態・交通の規制・天気とは違うことがあります。",
            "走るときは交通の決まりと現地の標識に従い、自分で安全を確かめてください。",
            "走っている間に画面を見続けたり操作したりしないでください。",
          ]}
        />
      </LegalSection>

      <LegalSection title="してはいけないこと">
        <LegalList
          items={[
            "アプリやサーバーに大量の要求を送る等、運営を妨げること",
            "ほかの人のアカウントでログインすること",
            "法令や公の秩序に反すること",
          ]}
        />
      </LegalSection>

      <LegalSection title="運営者の責任">
        <p className="m-0">
          運営者は、アプリを予告なく変えたり止めたりすることがあります。アプリの情報を使って起きた損害について、運営者に故意または重い過失がある場合を除き、責任を負いません。
        </p>
      </LegalSection>

      <LegalSection title="規約を変えるとき">
        <p className="m-0">
          運営者はこの規約とプライバシーポリシーを変えることがあります。走りの扱いに関わる変更は版を上げ、次にアプリを開いたときに同意を聞き直します。
        </p>
      </LegalSection>

      <ContactSection />
    </LegalPage>
  );
}
