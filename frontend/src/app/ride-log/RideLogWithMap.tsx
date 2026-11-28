"use client";

import RideTrackMap from "@/features/map/RideTrackMap/RideTrackMap";
import RideLog from "@/features/ride/RideLog/RideLog";

/** 走行ログに、走った線を描く地図を渡す。 */
export default function RideLogWithMap() {
  return <RideLog trackMap={(lines) => <RideTrackMap lines={lines} />} />;
}
