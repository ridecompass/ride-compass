"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button/Button";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import { downloadFile } from "@/lib/downloadFile";
import { clearRideTracks, isRideTrackEnabled, readRideTracks, setRideTrackEnabled } from "@/lib/rideTrack";
import { formatJstDateTime } from "@/lib/time";

/** 走りの位置の記録（`lib/rideTrack.ts`）を入れる・書き出す・消す。記録は端末の中だけにあり、書き出したファイルを開発機で
 * 時計の記録と比べる。 */
export default function RideTrackPanel() {
  const [enabled, setEnabled] = useState(isRideTrackEnabled);
  const [tracks, setTracks] = useState(readRideTracks);

  return (
    <section aria-label="走りの位置の記録" className="flex flex-col gap-2">
      <label className="flex items-center gap-[0.3rem] text-[length:var(--font-size-md)]">
        <Checkbox
          checked={enabled}
          onCheckedChange={(next) => {
            setRideTrackEnabled(next);
            setEnabled(next);
          }}
          aria-label="走行中の位置を端末に記録する"
        />
        走行中の位置を端末に記録する
      </label>
      {tracks.length === 0 ? (
        <p>記録した走りはありません。</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {tracks.map((track) => (
            <li key={track.id}>
              {formatJstDateTime(new Date(track.startedAt))} から・{track.points.length}点
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button
          usage={null}
          disabled={tracks.length === 0}
          onClick={() => downloadFile("ridecompass-ride-tracks.json", JSON.stringify(tracks), "application/json")}
        >
          書き出す
        </Button>
        <Button
          usage={null}
          variant="ghost"
          disabled={tracks.length === 0}
          onClick={() => {
            clearRideTracks();
            setTracks([]);
          }}
        >
          消す
        </Button>
      </div>
    </section>
  );
}
