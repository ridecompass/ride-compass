// 撮影（scripts/capture.mjs）が開く版の取り出しと、ビルドを使い回してよいかの見分け。

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { fail, frontendRoot, run } from "./shell.mjs";

/** <git の版> の frontend を取り出して依存を入れ、そのディレクトリと版の commit を返す。 */
export function checkoutRef(ref) {
  let commit;
  try {
    commit = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: frontendRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    fail(`--app の版が無い: ${ref}（git fetch origin の後に打ち直す）`);
  }
  const dir = path.join(os.tmpdir(), `ridecompass-capture-${commit.slice(0, 12)}`, "frontend");
  // 取り出しと依存の導入が両方通った後にだけ印を書く。途中で落ちた残り（欠けた展開・入れかけの node_modules）は消して始めから。
  const ready = path.join(dir, ".capture-ready");
  if (!existsSync(ready)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // git archive はサブディレクトリから打つとその下へ絞るので、リポジトリの根から打つ。
    const archive = spawnSync("git", ["archive", `${commit}:frontend`], {
      cwd: path.dirname(frontendRoot),
      maxBuffer: 1 << 30,
    });
    if (archive.status !== 0) fail(`${ref} の frontend を取り出せない: ${archive.stderr}`);
    // 展開の先は引数でなく作業ディレクトリで渡す: Git Bash の GNU tar は `C:` を含むパスを別のマシンの名前と読んで開けない。
    const extract = spawnSync("tar", ["-x", "-f", "-"], { cwd: dir, input: archive.stdout });
    if (extract.status !== 0) fail(`${ref} の frontend を展開できない: ${extract.stderr}`);
    console.log(`[capture] ${ref}（${commit.slice(0, 12)}）の依存を入れる: ${dir}`);
    if (run("npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund"], { cwd: dir }) !== 0)
      fail("依存を入れられない");
    writeFileSync(ready, "");
  }
  return { dir, commit, source: commit };
}

/**
 * 作業ツリーの frontend の中身の指紋。git が無視しないファイル（コミットしていない変更・まだ足していないファイルも）の
 * パスと中身から作り、ビルドを使い回してよいかを見分ける。
 */
export function worktreeFingerprint() {
  const hash = createHash("sha256");
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: frontendRoot,
    encoding: "utf-8",
  });
  for (const file of [...new Set(files.split("\0").filter(Boolean))].sort()) {
    const full = path.join(frontendRoot, file);
    hash.update(`${file}\0`);
    // 消したがまだコミットしていないファイルは、git が一覧に出すが中身が無い。
    hash.update(existsSync(full) ? readFileSync(full) : "(消した)");
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** ビルドの印（作った版の中身と埋め込んだ環境変数）。ほかの道具（e2e 等）の next build は .next を消してから作るので、印も消える。 */
export function builtWith(dir) {
  const marker = path.join(dir, ".next", "capture-build");
  return existsSync(path.join(dir, ".next", "BUILD_ID")) && existsSync(marker) ? readFileSync(marker, "utf-8") : null;
}
