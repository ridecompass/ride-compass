"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/Button/Button";
import { textVariants } from "@/components/ui/Text/Text";
import { errorMessage } from "@/lib/apiError";
import { cn } from "@/lib/cn";
import { formatDurationShort } from "@/lib/duration";
import { formatAlongDistance } from "@/lib/geoDistance";
import { getQueryClient } from "@/lib/queryClient";
import { formatJstDateTime, jstParts } from "@/lib/time";
import GoogleSignInButton from "@/components/GoogleSignInButton/GoogleSignInButton";
import { ACCOUNT_KEY, useAccountStatus, useGoogleSignIn } from "@/hooks/useAccountStatus";
import {
  deleteMyRide,
  getMyRide,
  listMyRides,
  signOut,
  withdrawConsent,
  type RideDetail,
  type RideSummary,
} from "@/services/accountApi";

const RIDES_KEY = ["my-rides"] as const;

/** 走った線（休むごとに分けた線。点は[経度, 緯度]）。 */
type RideTrackCoordinates = RideDetail["track"]["coordinates"];

interface RideLogProps {
  /** 1件の走った線を描く地図。 */
  trackMap: (lines: RideTrackCoordinates) => ReactNode;
}

/** 走行ログのページの中身。自分の走りの一覧と1件の走った線を見せて1件ずつ消し、ログアウトと記録をやめる操作を置く。 */
export default function RideLog({ trackMap }: RideLogProps) {
  const t = useTranslations();
  const account = useAccountStatus();
  const signIn = useGoogleSignIn();
  const status = account.data;

  if (account.error) return <ErrorText error={account.error} />;
  if (status === undefined) return <Loading />;
  if (!status.signed_in)
    return (
      <section className="flex flex-col gap-3">
        <p className={cn(textVariants({ variant: "body" }), "m-0")}>{t("ride.log.signInPrompt")}</p>
        {status.google_client_id === null ? (
          <p className={cn(textVariants({ variant: "hint" }), "m-0")}>{t("account.signInUnavailable")}</p>
        ) : (
          <GoogleSignInButton
            clientId={status.google_client_id}
            onCredential={(credential) => signIn.mutate(credential)}
          />
        )}
        {signIn.error && <ErrorText error={signIn.error} />}
      </section>
    );
  return (
    <>
      <RideList trackMap={trackMap} />
      <AccountSection consented={status.consented} />
    </>
  );
}

function RideList({ trackMap }: RideLogProps) {
  const t = useTranslations("ride.log");
  const client = getQueryClient();
  const rides = useQuery({ queryKey: RIDES_KEY, queryFn: listMyRides }, client);
  const [openId, setOpenId] = useState<string | null>(null);

  if (rides.error) return <ErrorText error={rides.error} />;
  if (rides.data === undefined) return <Loading />;
  if (rides.data.length === 0) return <p className={cn(textVariants({ variant: "hint" }), "m-0")}>{t("empty")}</p>;
  return (
    <ul aria-label={t("list")} className="m-0 flex list-none flex-col gap-2 p-0">
      {rides.data.map((ride) => (
        <li key={ride.id} className="flex flex-col gap-2">
          <Button
            usage={null}
            variant="menu"
            className="justify-between rounded-md border border-[var(--color-border)] px-3 py-2"
            aria-expanded={openId === ride.id}
            onClick={() => setOpenId(openId === ride.id ? null : ride.id)}
          >
            <RideLine ride={ride} />
          </Button>
          {openId === ride.id && <RideOpened rideId={ride.id} trackMap={trackMap} onDeleted={() => setOpenId(null)} />}
        </li>
      ))}
    </ul>
  );
}

function RideLine({ ride }: { ride: RideSummary }) {
  const started = new Date(ride.started_at);
  return (
    <>
      <span>
        {jstParts(started).year}/{formatJstDateTime(started)}
      </span>
      <span className="flex gap-3">
        <span>{formatAlongDistance(ride.distance_m)}</span>
        <span>{formatDurationShort(ride.duration_s)}</span>
      </span>
    </>
  );
}

function RideOpened({
  rideId,
  trackMap,
  onDeleted,
}: {
  rideId: string;
  trackMap: RideLogProps["trackMap"];
  onDeleted: () => void;
}) {
  const t = useTranslations("ride.log");
  const client = getQueryClient();
  const ride = useQuery({ queryKey: ["my-ride", rideId], queryFn: () => getMyRide(rideId) }, client);
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation(
    {
      mutationFn: () => deleteMyRide(rideId),
      onSuccess: () => {
        onDeleted();
        client.removeQueries({ queryKey: ["my-ride", rideId] });
        void client.invalidateQueries({ queryKey: RIDES_KEY });
      },
    },
    client,
  );

  return (
    <div className="flex flex-col gap-2">
      {ride.error ? (
        <ErrorText error={ride.error} />
      ) : ride.data === undefined ? (
        <Loading />
      ) : ride.data.track.coordinates.length === 0 ? (
        <p className={cn(textVariants({ variant: "hint" }), "m-0")}>{t("noTrack")}</p>
      ) : (
        trackMap(ride.data.track.coordinates)
      )}
      {confirming ? (
        <div className="flex items-center justify-end gap-2">
          <span className={textVariants({ variant: "body" })}>{t("deleteWarning")}</span>
          <Button usage={null} variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            {t("deleteCancel")}
          </Button>
          <Button usage={null} variant="danger" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {t("deleteConfirm")}
          </Button>
        </div>
      ) : (
        <Button usage={null} variant="ghost" size="sm" className="self-end" onClick={() => setConfirming(true)}>
          {t("delete")}
        </Button>
      )}
      {remove.error && <ErrorText error={remove.error} />}
    </div>
  );
}

function AccountSection({ consented }: { consented: boolean }) {
  const t = useTranslations("ride.log");
  const client = getQueryClient();
  const refresh = () => {
    client.removeQueries({ queryKey: RIDES_KEY });
    void client.invalidateQueries({ queryKey: ACCOUNT_KEY });
  };
  const withdraw = useMutation({ mutationFn: withdrawConsent, onSuccess: refresh }, client);
  const logout = useMutation({ mutationFn: signOut, onSuccess: refresh }, client);

  return (
    <section className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-4">
      {consented ? (
        <div className="flex flex-col gap-2">
          <p className={cn(textVariants({ variant: "hint" }), "m-0")}>{t("withdrawWarning")}</p>
          <Button
            usage={null}
            variant="ghost"
            size="sm"
            className="self-start"
            disabled={withdraw.isPending}
            onClick={() => withdraw.mutate()}
          >
            {t("withdraw")}
          </Button>
        </div>
      ) : (
        <p className={cn(textVariants({ variant: "hint" }), "m-0")}>{t("withdrawn")}</p>
      )}
      <Button
        usage={null}
        variant="ghost"
        size="sm"
        className="self-start"
        disabled={logout.isPending}
        onClick={() => logout.mutate()}
      >
        {t("signOut")}
      </Button>
      {withdraw.error && <ErrorText error={withdraw.error} />}
      {logout.error && <ErrorText error={logout.error} />}
    </section>
  );
}

function ErrorText({ error }: { error: unknown }) {
  return (
    <p role="alert" className={cn(textVariants({ variant: "error" }), "m-0")}>
      {errorMessage(error)}
    </p>
  );
}

function Loading() {
  const t = useTranslations("common");
  return <p className={cn(textVariants({ variant: "hint" }), "m-0")}>{t("loading")}</p>;
}
