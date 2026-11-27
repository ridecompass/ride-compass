import type { CaptureScript } from "../context";

// 脚本の例: 地図の塗りを、位置と倍率を決めて、画面に出ているレンズごとに撮る。レンズの一覧は費用の軸の定義から作られ、
// デプロイなしで変わるので、名前を決め打ちせず画面から読む。
//   node frontend/scripts/capture.mjs --script frontend/capture/examples/map-lens.ts
//   node frontend/scripts/capture.mjs --app production --script frontend/capture/examples/map-lens.ts
//   node frontend/scripts/capture.mjs --api <本番の backend> --script frontend/capture/examples/map-lens.ts

const script: CaptureScript = async ({ open, lenses, chooseLens, shot }) => {
  await open({ point: { latitude: 35.681, longitude: 139.767 }, zoom: 15 });
  for (const lens of await lenses()) {
    await chooseLens(lens);
    await shot(lens);
  }
};

export default script;
