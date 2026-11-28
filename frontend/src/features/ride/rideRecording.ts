import { getQueryClient } from "@/lib/queryClient";
import { recordRideFix, setRideMetricsStatus, startRideMetrics, stopRideMetrics } from "@/lib/rideMetrics";
import {
  recordRideTrackFix,
  recordRideTrackStatus,
  setRideTrackAppVersion,
  startRideTrack,
  stopRideTrack,
} from "@/lib/rideTrack";
import { frontendVersionQuery } from "@/services/versionApi";

/** 走行モードを始めたとき。走行の計測と走りの記録を始める。 */
export function startRideRecording(nowMs: number): void {
  startRideMetrics();
  startRideTrack(nowMs);
  // 走りを記録した画面の版を添える（読めなければ null。版のために走りを止めない）。
  void getQueryClient()
    .fetchQuery(frontendVersionQuery)
    .then(
      (version) => setRideTrackAppVersion(version.commit),
      () => setRideTrackAppVersion(null),
    );
}

/** 走行モードを止めたとき。計測と記録を止める（走りは端末に残り、送るかは利用者に聞いてから決める）。 */
export function stopRideRecording(nowMs: number): void {
  stopRideMetrics();
  stopRideTrack(nowMs);
}

/** 走行の状態が変わったとき。 */
export function recordRideStatus(status: string, nowMs: number): void {
  setRideMetricsStatus(status);
  recordRideTrackStatus(status, nowMs);
}

export const finiteOrNull = (value: number | null) => (value !== null && Number.isFinite(value) ? value : null);

/** 受けた位置。`speedMs`は位置から出した速さ（秒速m。出せなければ null）で、計測にだけ使う（記録は端末の値を残す）。 */
export function recordRidePosition(received: GeolocationPosition, speedMs: number | null): void {
  const { latitude, longitude, altitude, altitudeAccuracy, heading, speed, accuracy } = received.coords;
  const accuracyM = finiteOrNull(accuracy);
  recordRideFix(accuracyM, speedMs, received.timestamp);
  recordRideTrackFix({
    latitude,
    longitude,
    altitudeM: finiteOrNull(altitude),
    accuracyM,
    altitudeAccuracyM: finiteOrNull(altitudeAccuracy),
    speedMs: finiteOrNull(speed),
    headingDeg: finiteOrNull(heading),
    timestampMs: received.timestamp,
  });
}
