"use client";

import { useCallback, useRef, useState } from "react";

import { ApiHttpError } from "@/lib/apiClient";
import { errorMessage } from "@/lib/apiError";
import { endedRideIds, removeRideTrack } from "@/lib/rideTrackStore";
import { consentToTerms, getAccountStatus, signInWithGoogle, type AccountStatus } from "@/services/accountApi";
import { sendRideTracks } from "@/services/rideTrackApi";

/** 走り終えた走りを残すかを聞くカードの段。 */
export type RideKeepStep =
  | { kind: "hidden" }
  /** ログインして同意するまで送らず、残すかを聞く。 */
  | { kind: "ask" }
  /** Google でログインしてもらう。`clientId`が null の環境はログインできない。 */
  | { kind: "signIn"; clientId: string | null; message: string | null }
  /** 今の規約の版に同意してもらう。 */
  | { kind: "consent"; termsVersion: number; message: string | null }
  | { kind: "sending" }
  | { kind: "kept" }
  /** 送れなかった・聞けなかった。走りは端末に残り、次に案内を終えたときに聞き直す。 */
  | { kind: "failed"; message: string };

const HIDDEN: RideKeepStep = { kind: "hidden" };

/**
 * 案内を終えた走りを残すか。走りは、ログインして今の規約の版に同意した人のものだけを送り、それまでは端末にだけ置く。
 * 同意済みなら聞かずに送り、そうでなければ送っていない走りがあるときだけ聞く。
 */
export function useRideKeep() {
  const [step, setStep] = useState<RideKeepStep>(HIDDEN);
  // 聞いている間に読んだ自分の状態（ログインと同意の段を選ぶ）。
  const account = useRef<AccountStatus | null>(null);

  const send = useCallback(async () => {
    setStep({ kind: "sending" });
    setStep(
      (await sendRideTracks())
        ? { kind: "kept" }
        : { kind: "failed", message: "残せませんでした。走りは端末に置き、次に案内を終えたときに送り直します" },
    );
  }, []);

  const proceed = useCallback(
    (status: AccountStatus, message: string | null = null) => {
      account.current = status;
      if (!status.signed_in) setStep({ kind: "signIn", clientId: status.google_client_id, message });
      else if (!status.consented) setStep({ kind: "consent", termsVersion: status.terms_version, message });
      else void send();
    },
    [send],
  );

  /** 案内を終えたとき。 */
  const offer = useCallback(() => {
    if (endedRideIds().length === 0) return;
    getAccountStatus().then(
      (status) => {
        account.current = status;
        if (status.signed_in && status.consented) void send();
        else setStep({ kind: "ask" });
      },
      (error: unknown) =>
        setStep({
          kind: "failed",
          message: `${errorMessage(error)}。走りは端末に置き、次に案内を終えたときに聞き直します`,
        }),
    );
  }, [send]);

  /** 「この走りを残す」。 */
  const keep = useCallback(() => {
    if (account.current !== null) proceed(account.current);
  }, [proceed]);

  /** Google が ID トークンを渡したとき。 */
  const signIn = useCallback(
    async (credential: string) => {
      try {
        proceed(await signInWithGoogle(credential));
      } catch (error) {
        setStep({ kind: "signIn", clientId: account.current?.google_client_id ?? null, message: errorMessage(error) });
      }
    },
    [proceed],
  );

  /** 「同意して残す」。 */
  const consent = useCallback(
    async (termsVersion: number) => {
      try {
        await consentToTerms(termsVersion);
      } catch (error) {
        // 見せている間に規約の版が上がった。今の版を読み直して見せ直す。
        if (error instanceof ApiHttpError && error.status === 409) {
          try {
            proceed(await getAccountStatus(), error.message);
            return;
          } catch (reread) {
            error = reread;
          }
        }
        setStep({ kind: "consent", termsVersion, message: errorMessage(error) });
        return;
      }
      void send();
    },
    [proceed, send],
  );

  /** 「残さない」。送っていない走りを端末から消す。 */
  const discard = useCallback(() => {
    for (const id of endedRideIds()) removeRideTrack(id);
    setStep(HIDDEN);
  }, []);

  const close = useCallback(() => setStep(HIDDEN), []);

  return { step, offer, keep, signIn, consent, discard, close };
}

export type RideKeep = ReturnType<typeof useRideKeep>;
