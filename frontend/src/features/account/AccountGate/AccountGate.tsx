"use client";

import { useMutation } from "@tanstack/react-query";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import GoogleSignInButton from "@/components/GoogleSignInButton/GoogleSignInButton";
import { Button } from "@/components/ui/Button/Button";
import { cardVariants } from "@/components/ui/Card/Card";
import { GuideText } from "@/components/ui/GuideText/GuideText";
import { textVariants } from "@/components/ui/Text/Text";
import { ACCOUNT_KEY, useAccountStatus } from "@/hooks/useAccountStatus";
import { ApiHttpError } from "@/lib/apiClient";
import { errorMessage } from "@/lib/apiError";
import { cn } from "@/lib/cn";
import { getQueryClient } from "@/lib/queryClient";
import { endedRideIds, removeRideTrack } from "@/lib/rideTrackStore";
import { APP_NAME } from "@/lib/screenNames";
import { consentToTerms, signInWithGoogle, type AccountStatus } from "@/services/accountApi";

/**
 * Google でログインして今の規約の版に同意するまで、地図の画面の上に最初の画面を重ね、後ろの地図は触れなくする。最初の画面の
 * 「Google でログイン」は、規約への同意も兼ねる（押す前に、同意になることと集めるもの・使い道を同じ画面に書く）。ログインせずに使う
 * ボタンや、同意せずに使うボタンは置かない。同意のカードは、ログインしたあとに規約の版が上がった人にだけ出す。
 * `children` には済んだか（`open`）を渡す。
 */
export default function AccountGate({ children }: { children: (open: boolean) => ReactNode }) {
  const account = useAccountStatus();
  const status = account.data;
  const open = Boolean(status?.signed_in && status.consented);

  return (
    <>
      <div inert={!open} aria-hidden={!open || undefined} className="contents">
        {children(open)}
      </div>
      {!open && (
        <div className="fixed inset-0 z-[var(--z-floating-panel)] flex items-center justify-center overflow-y-auto bg-black/40 p-4">
          {status?.signed_in ? <ConsentCard status={status} /> : <Welcome status={status} account={account} />}
        </div>
      )}
    </>
  );
}

const CARD_CLASS = cn(cardVariants({ variant: "float" }), "flex w-full max-w-md flex-col gap-3 p-4");

// 自分の状態を読むまでも、アプリの説明と規約へのリンクは出す（ログインしなくても読めるホームページとして、Google のブランドの確認が求める）。
function Welcome({
  status,
  account,
}: {
  status: AccountStatus | undefined;
  account: ReturnType<typeof useAccountStatus>;
}) {
  const client = getQueryClient();
  // ログインは同意を兼ねる。ログインした応答の版に、その場で同意を残す（済んでいれば残さない）。
  const signIn = useMutation(
    {
      mutationFn: async (credential: string) => {
        const signedIn = await signInWithGoogle(credential);
        if (signedIn.consented) return signedIn;
        await consentToTerms(signedIn.terms_version);
        return { ...signedIn, consented: true };
      },
      onSuccess: (next: AccountStatus) => {
        clearRidesBeforeConsent();
        client.setQueryData(ACCOUNT_KEY, next);
      },
      // ログインだけ済んで同意を残せなかったら、読み直して同意のカードで聞き直す。
      onError: () => void client.invalidateQueries({ queryKey: ACCOUNT_KEY }),
    },
    client,
  );
  return (
    <section aria-labelledby="welcome-title" className={CARD_CLASS}>
      <h1 id="welcome-title" className={cn(textVariants({ variant: "title" }), "m-0 flex items-center gap-2")}>
        <Image src="/icon.svg" alt="" width={36} height={36} unoptimized />
        {APP_NAME}
      </h1>
      <p className={cn(textVariants({ variant: "body" }), "m-0")}>
        <GuideText text="ロードバイクで走りやすいルートを作るアプリです。" />
      </p>
      <ul className={cn(textVariants({ variant: "body" }), "m-0 flex list-disc flex-col gap-1 pl-5")}>
        {[
          "出発地へ戻る周回も、目的地へ向かうルートも作れます。",
          "坂・路面・車の多さを見て、走りやすい道を選びます。",
          "走行モードでは、次に曲がる所・残りの道のり・天気を案内します。",
          "走行モードで走った記録は送られ、あなたの走行ログに残ります。走行ログでは、自分の走りを見返したり消したりできます。",
        ].map((point) => (
          <li key={point}>
            <GuideText text={point} />
          </li>
        ))}
      </ul>
      <p className={cn(textVariants({ variant: "body" }), "m-0 break-keep wrap-anywhere")}>
        {/* 折り返すのは句の間だけにする（ほかの文は GuideText が同じことをする）。 */}
        Google でログインすると、
        <wbr />
        <LegalLinks />
        に
        <wbr />
        同意したことに
        <wbr />
        なります。
      </p>
      {account.error ? (
        <>
          <p role="alert" className={cn(textVariants({ variant: "error" }), "m-0")}>
            {errorMessage(account.error)}
          </p>
          <Button
            usage="ログインの状態をもう一度読みます。"
            variant="primary"
            size="sm"
            className="self-start"
            disabled={account.isFetching}
            onClick={() => void account.refetch()}
          >
            もう一度読む
          </Button>
        </>
      ) : status === undefined ? (
        <p className={cn(textVariants({ variant: "hint" }), "m-0")}>読み込み中…</p>
      ) : status.google_client_id === null ? (
        <p className={cn(textVariants({ variant: "hint" }), "m-0")}>この環境ではログインできません。</p>
      ) : (
        <GoogleSignInButton
          clientId={status.google_client_id}
          onCredential={(credential) => signIn.mutate(credential)}
        />
      )}
      {signIn.error && (
        <p role="alert" className={cn(textVariants({ variant: "error" }), "m-0")}>
          {errorMessage(signIn.error)}
        </p>
      )}
    </section>
  );
}

function ConsentCard({ status }: { status: AccountStatus }) {
  const client = getQueryClient();
  const consent = useMutation(
    {
      mutationFn: () => consentToTerms(status.terms_version),
      onSuccess: () => {
        clearRidesBeforeConsent();
        client.setQueryData(ACCOUNT_KEY, { ...status, consented: true });
      },
      // 見せている間に規約の版が上がった（409）。今の版を読み直して見せ直す。
      onError: (error) => {
        if (error instanceof ApiHttpError && error.status === 409)
          void client.invalidateQueries({ queryKey: ACCOUNT_KEY });
      },
    },
    client,
  );

  return (
    <section aria-labelledby="consent-title" className={CARD_CLASS}>
      <h1 id="consent-title" className={cn(textVariants({ variant: "heading" }), "m-0")}>
        走りの記録への同意
      </h1>
      <p className={cn(textVariants({ variant: "body" }), "m-0")}>
        {APP_NAME} を使うと、走行モードで走った走りを毎回送り、走行ログに残します。同意すると、地図の画面へ進みます。
      </p>
      <ul className={cn(textVariants({ variant: "body" }), "m-0 flex list-disc flex-col gap-1 pl-5")}>
        <li>走りの位置と時刻・推したルート・生成の条件・見せた予報・端末とブラウザの名前を残します。</li>
        <li>あなたが走行ログで見返すことと、ルート生成の精度を上げる分析に使います。</li>
        <li>名前・メール・IP は持たず、あなたの走りを外へ出しません。</li>
      </ul>
      <p className={cn(textVariants({ variant: "hint" }), "m-0")}>
        詳しくは
        <LegalLinks />
        を読んでください。
      </p>
      <Button
        usage="利用規約とプライバシーポリシーに同意して、アプリを使い始めます。"
        variant="primary"
        size="sm"
        className="self-end"
        disabled={consent.isPending}
        onClick={() => consent.mutate()}
      >
        同意してはじめる
      </Button>
      {consent.error && (
        <p role="alert" className={cn(textVariants({ variant: "error" }), "m-0")}>
          {errorMessage(consent.error)}
        </p>
      )}
    </section>
  );
}

// 同意する前に記録して端末に置いたままの走りは、同意の外なので送らずに消す。
function clearRidesBeforeConsent() {
  for (const id of endedRideIds()) removeRideTrack(id);
}

function LegalLinks() {
  return (
    <>
      <Link href="/terms" className="underline">
        利用規約
      </Link>
      と
      <Link href="/privacy" className="underline">
        プライバシーポリシー
      </Link>
    </>
  );
}
