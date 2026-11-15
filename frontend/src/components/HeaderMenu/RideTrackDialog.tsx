"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { DialogContent } from "@/components/ui/Dialog/Dialog";
import { Input } from "@/components/ui/Input/Input";
import { textVariants } from "@/components/ui/Text/Text";
import { pendingRideCount, rideTrackWriteKey, setRideTrackWriteKey } from "@/lib/rideTrack";

// 鍵は要求の見出しで送るので、見出しに載る文字（空白の無い ASCII）だけを受ける。
const KEY_PATTERN = /^[!-~]+$/;

/** 走りの記録（`lib/rideTrack.ts`）の鍵を入れる・外す窓。鍵を入れた端末だけが走りを記録し、案内を終えたら送る。 */
export function RideTrackDialog() {
  const [writeKey, setWriteKey] = useState(rideTrackWriteKey);
  const [draft, setDraft] = useState("");
  const [pending] = useState(pendingRideCount);

  return (
    <DialogContent title="走りの記録">
      <p className={textVariants({ variant: "hint" })}>
        鍵を入れたこの端末で、走行モードの走りを記録し、案内を終えたら送ります。送れなかった走りは、次に案内を終えたときに送ります。
      </p>
      {writeKey === null ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const key = draft.trim();
            setRideTrackWriteKey(key);
            setWriteKey(key);
          }}
        >
          <Input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="書くための鍵"
            data-usage="走りの記録を頼まれたときに受け取った、書くための鍵を入れます。"
            className="flex-1"
          />
          <Button
            type="submit"
            usage="入れた鍵で、この端末の走りの記録を始めます。"
            disabled={!KEY_PATTERN.test(draft.trim())}
          >
            入れる
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <p className={textVariants({ variant: "body" })}>鍵を入れています。</p>
          <Button
            variant="ghost"
            usage="鍵を外し、この端末で走りを記録しないようにします。"
            onClick={() => {
              setRideTrackWriteKey(null);
              setWriteKey(null);
            }}
          >
            鍵を外す
          </Button>
        </div>
      )}
      <p className={textVariants({ variant: "body" })}>送っていない走り: {pending}件</p>
    </DialogContent>
  );
}
