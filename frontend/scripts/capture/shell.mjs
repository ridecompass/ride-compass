// 撮影（scripts/capture.mjs）が道具を起こす口。

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const frontendRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const playwright = path.join(frontendRoot, "node_modules", "@playwright", "test", "cli.js");

export function fail(message) {
  console.error(`[capture] ${message}`);
  process.exit(1);
}

/**
 * Windows の npm は .cmd で、.cmd はシェル越しでしか起こせない。シェル越しの引数は引用されず、空白を含むパス（例: process.execPath）は
 * 切れるので、絶対パスで渡す実行ファイルはシェルを通さない。
 */
export function run(command, args, { cwd = frontendRoot, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32" && !path.isAbsolute(command),
  });
  return result.status ?? 1;
}

/** Chromium を入れて起こせるかを試し、Linux なら起こすのに要る依存と日本語のフォントを入れる。 */
export function prepareBrowser() {
  if (run(process.execPath, [playwright, "install", "chromium"]) !== 0) fail("Chromium を入れられない");
  if (process.platform !== "linux") return;
  const launches = () =>
    spawnSync(
      process.execPath,
      [
        "-e",
        "require('@playwright/test').chromium.launch().then((b) => b.close()).then(() => process.exit(0), () => process.exit(1))",
      ],
      { cwd: frontendRoot },
    ).status === 0;
  if (!launches()) {
    console.log("[capture] Chromium を起こせないので、起こすのに要る依存を入れる");
    run("sudo", ["-n", process.execPath, playwright, "install-deps", "chromium"]);
    if (!launches())
      fail(
        `Chromium を起こせない（sudo ${process.execPath} ${playwright} install-deps chromium を打ってから打ち直す）`,
      );
  }
  const japanese = () => {
    try {
      return execFileSync("fc-list", [":lang=ja"], { encoding: "utf-8" }).trim().length > 0;
    } catch {
      return false;
    }
  };
  if (japanese()) return;
  console.log("[capture] 日本語のフォントが無いので fonts-noto-cjk を入れる");
  run("sudo", ["-n", "apt-get", "install", "-y", "-q", "fonts-noto-cjk"]);
  if (!japanese()) fail("日本語のフォントを入れられない（fonts-noto-cjk 等を入れてから打ち直す）");
}
