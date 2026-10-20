// 本番の frontend の像を作る（ci.yml の frontend-image と、deploy-frontend.yml の手動の起動が呼ぶ）。
//
//   node frontend/scripts/image.mjs <像のタグ> <コミット>
//
// 宛先は本番の backend（リポジトリの根の production-origins.json。docs/architecture/tech-stack.md「本番の宛先」）。
// 像へ渡す環境変数の組（imageEnv）は、scripts/capture.mjs が手元で起動する版へも同じ組で渡す。

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 本番の frontend と backend のオリジン。 */
export const productionOrigins = JSON.parse(
  readFileSync(path.join(frontendRoot, "..", "production-origins.json"), "utf-8"),
);

/**
 * 像のビルドへ渡す環境変数。画面の API・タイル・rewrites と管理画面の転送の先は、どれも backend へ直接向ける。
 * NEXT_PUBLIC_ の値はビルドのときに埋め込まれる。
 */
export function imageEnv(backend, commit) {
  return {
    NEXT_PUBLIC_API_URL: backend,
    NEXT_PUBLIC_TILE_BASE_URL: backend,
    BACKEND_INTERNAL_URL: backend,
    GIT_COMMIT: commit,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tag, commit] = process.argv.slice(2);
  if (!tag || !commit) {
    console.error("使い方: node frontend/scripts/image.mjs <像のタグ> <コミット>");
    process.exit(1);
  }
  const buildArgs = Object.entries(imageEnv(productionOrigins.backend, commit)).flatMap(([name, value]) => [
    "--build-arg",
    `${name}=${value}`,
  ]);
  const result = spawnSync("docker", ["build", frontendRoot, ...buildArgs, "--tag", tag], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
