// iPhone の向きを読む許しを求める口（`DeviceOrientationEvent.requestPermission`。テスト環境に無いブラウザの機能）の代役。

const holder = globalThis as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } };

/** 操作の外で、まだ聞いていない許しを求めたときの iPhone の Safari の断り方。 */
export const unaskedPermission = () =>
  new DOMException("Requesting device orientation access requires a user gesture to prompt", "NotAllowedError");

/**
 * 許しを求める口を置き、求められるたびに`answer`の返す答えを返す（投げれば断る）。`undefined`なら口を外す
 * （許しの要らない端末）。
 */
export function setOrientationPermission(answer: (() => string) | undefined) {
  holder.DeviceOrientationEvent = answer && { requestPermission: async () => answer() };
}
