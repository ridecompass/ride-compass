import type { Metadata } from "next";
import { useTranslations } from "next-intl";

import { ContactSection, LegalList, LegalPage, LegalSection, OPERATOR } from "@/components/LegalPage/LegalPage";
import { translate } from "@/i18n/config";

export const metadata: Metadata = { title: `プライバシーポリシー | ${translate("common.appName")}` };

export default function PrivacyPage() {
  const t = useTranslations("common");
  return (
    <LegalPage title="プライバシーポリシー" revised="2026-11-28">
      <p className="m-0">
        {OPERATOR}（以下「運営者」）は、{t("appName")}
        で、次のとおり情報を扱います。アプリを使うには、Google
        でログインしてもらい、ログインすることがこのポリシーと利用規約への同意になります。アプリを使うことは、走行モードで走った走りを送って走行ログに残すことへの同意になります。
      </p>

      <LegalSection title="集めるもの">
        <LegalList
          items={[
            "走りの位置と時刻の連続（走行モードの間に端末が測った位置・高さ・速さ・向き・誤差と、その時刻）",
            "走っている間に推したルートと、そのルートを作った生成の条件",
            "走っている間に見せた天気の予報",
            "走行モードを始めた・休んだ・終えた等の出来事と、その時刻",
            "端末とブラウザの名前",
            "ログインに使った Google のアカウントを見分ける番号（Google がアプリごとに配るもの）と、同意した規約の版と日時",
          ]}
        />
      </LegalSection>

      <LegalSection title="使い道">
        <LegalList
          items={[
            "あなたが走行ログで自分の走りを見返すこと",
            "推したルートと実際に走った道を突き合わせて、ルート生成の精度を上げる分析",
          ]}
        />
      </LegalSection>

      <LegalSection title="持たないもの">
        <p className="m-0">
          名前・メールアドレス・IP アドレスは、アカウントにも走りにも結び付けて持ちません。Google
          からは、アカウントを見分ける番号だけを受け取ります。
        </p>
      </LegalSection>

      <LegalSection title="外へ出さないこと">
        <p className="m-0">
          個人ごとの走りを、運営者の外へ出すこと（第三者へ渡す・公開する・売る）はしません。分析の結果を外で示すときは、個人の走りが分からない形にします。
        </p>
      </LegalSection>

      <LegalSection title="持つ期間">
        <p className="m-0">
          走りは、あなたが消すまで持ちます。同意をやめても、それまでに残した走りは消えずに残ります（消したいときは下の「走りの消し方」）。
        </p>
      </LegalSection>

      <LegalSection title="同意のやめ方と走りの消し方">
        <LegalList
          items={[
            "同意をやめる: 走行ログのページで同意をやめられます。やめるとアプリを使えなくなり、地図の画面を開くと最初の画面に戻ります。",
            "走りを消す: 走行ログのページで、自分の走りを1件ずつ消せます。",
            "ページで操作できないときや、全部の走りとアカウントをまとめて消したいときは、下の問い合わせ先へ連絡してください。",
          ]}
        />
      </LegalSection>

      <ContactSection />
    </LegalPage>
  );
}
