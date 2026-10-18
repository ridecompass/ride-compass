// 開発機の画面を本番の backend のデータで開く開発サーバーを起こす（docs/architecture/setup.md「開発機の画面を本番のデータで開く」）。
// 切り替え（RC_PROD_DATA）を入れて next dev を起こし、同じ Wi-Fi の端末からも開けるよう全部の口で待つ。
// 取り次ぎの向け先と API の宛先は next.config.ts が切り替えから決める。
import { spawn } from "node:child_process";

const child = spawn("npx", ["next", "dev", "-H", "0.0.0.0"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, RC_PROD_DATA: "1" },
});
child.on("exit", (code) => process.exit(code ?? 1));
