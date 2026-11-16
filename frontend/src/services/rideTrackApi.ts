import { backendApi } from "@/lib/apiClient";
import { debugLog } from "@/lib/debugLog";
import { pendingRideUploads, removeRideTrack } from "@/lib/rideTrackStore";

// 送っている間にもう一度呼ばれたら（送りの最中にもう一度案内を終えた等）、今の送りが済んでから送り直す。
let sending: Promise<void> | null = null;
let again = false;

// 書けたら消す。送れなければ（どの断りでも）端末に残して次に案内を終えたときに送り直し、後ろの走りは続けて送る——断りの理由を
// 見分けて消すと、frontend と backend の版がずれる間の断り（あとなら受けられた走り）も失う。
async function sendPending(): Promise<void> {
  for (const upload of pendingRideUploads()) {
    try {
      // 本番の nginx の要求の大きさの上限（既定の 1MB）に長い走りも収めるため、本文を gzip で縮めて送る。
      const compressed = await new Response(
        new Blob([JSON.stringify(upload)]).stream().pipeThrough(new CompressionStream("gzip")),
      ).blob();
      const { response } = await backendApi.POST("/api/rides", {
        body: upload,
        bodySerializer: () => compressed,
        headers: { "Content-Encoding": "gzip" },
      });
      if (response.ok) removeRideTrack(upload.id);
      else
        debugLog(
          "ride:track",
          `走りの記録を送れなかったので、端末に残した（HTTP ${response.status}）`,
          { id: upload.id },
          "warn",
        );
    } catch (error) {
      debugLog(
        "ride:track",
        "走りの記録を送れなかったので、端末に残した",
        { id: upload.id, error: String(error) },
        "warn",
      );
    }
  }
}

/** 走り終えて送っていない走りを、古い順に送る。書けたものから端末で消す。投げない。 */
export function sendRideTracks(): Promise<void> {
  if (sending !== null) {
    again = true;
    return sending;
  }
  sending = (async () => {
    do {
      again = false;
      await sendPending();
    } while (again);
  })().finally(() => {
    sending = null;
  });
  return sending;
}
