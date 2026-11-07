// 画面を、選んだ版と応答で開き、脚本で進めた状態を撮る（Pull Request の修正前後のキャプチャ。.claude/skills/task-work/SKILL.md「作る担当」の5）。
//
//   node scripts/capture.mjs [--script <脚本のファイル>] [--app production|worktree|<git の版>] [--api mock|<backend のオリジン>]
//     [--backend <パスの頭>]... [--size <幅>x<高さ>] [--theme light|dark] [--out <出力のディレクトリ>]
//
// --app は開く版: production は本番の frontend をそのまま開く（本番の backend を使うので --api を受けない）。worktree（既定）は
// 作業ツリーの版を、<git の版>（例: origin/master）はその版を一時のディレクトリへ取り出して（作業ツリーは切り替えない）、ビルドして
// 手元で起動する。取り出しは版の commit ごとに、ビルドは版の中身と渡す環境変数の組が前のビルドと同じときだけ使い回す（作業ツリーの
// 版は、git が無視しない frontend のファイルの中身で見分ける）。
// --api は応答: mock（既定）は e2e/fixtures.ts: installApiMocks（backend も外部も要らない）。<backend のオリジン> は本物の backend で、
// 地図の塗り（道路タイル）はこちらでしか出ない（本番の宛先は docs/architecture/tech-stack.md「本番の宛先」）。
// 手元で起動する版には、本番と同じ組の環境変数（frontendEnv）を渡す。frontend のコードが読む環境変数がその組に無ければ、撮る前に止まる。
// --backend は、ブラウザがそのパスの頭（例: /api/jma-tile/）で --api の backend へ取りに行くものだけを、作業ツリーの backend
// （backend/scripts/serve_capture.py。DB を読まずに起動する）が返す。backend が変える応答のうち DB を読まない経路（タイルの中継等）を
// 後の画面へ出すときに使い、何度でも付けられる。DB を読む経路の応答（本番の backend にまだ無い経路も）は、脚本の patch で替える。
// 脚本は default export の関数（capture/context.ts: CaptureScript）で、受け取った口（open・openAdmin・chooseLens・openLegend・clickMap・
// clickVisible・clickFeature・patch・shot 等）だけを使い、何も読み込まない。管理画面は openAdmin で開く（モックの応答のときだけ。撮影用の資格情報はここが渡す）。
// 作業ツリーの外に置いてよい（.ts も読める）。省略すると開いて1枚撮る。例は capture/examples/。
// 撮る前に、宛先（本番の frontend・本物の backend）が応答するまで待ち、Playwright の Chromium と、Linux なら起こすのに要る依存と
// 日本語のフォント（無いと文字が豆腐になる）を入れる。画像は <出力>/<版>/<幅>x<高さ>[-<テーマ>]/<番号>-<名前>.png
// （幅・テーマだけを変えて同じ --out へ撮り直しても、前の画像を上書きしない。版・幅・テーマが同じなら、前の画像を消してから撮る）。

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { fileName } from "../capture/fileName.mjs";
import { fail, frontendRoot, playwright, prepareBrowser, run } from "./capture/shell.mjs";
import { builtWith, checkoutRef, worktreeFingerprint } from "./capture/versions.mjs";
import { imageEnv, productionOrigins } from "./image.mjs";

/** e2e/fixtures.ts: installApiMocks が待ち受ける向け先。ビルドの環境変数に別の向け先があっても、モックへ向ける。 */
const MOCKED_API = "http://localhost:8000";
/** frontend/e2e・e2e-live・devサーバーと取り合わないポート。 */
const LOCAL_PORT = "3300";
/** --backend の作業ツリーの backend のポート。backend の開発・e2e-live（serve_e2e_live.py）と取り合わない。 */
const WORKTREE_BACKEND_PORT = "8300";
/** Render の無料のインスタンスは休止から起きるのに約1分かかる（https://render.com/docs/free）。その3倍まで待つ。 */
const WAKE_LIMIT_MS = 3 * 60_000;

/**
 * 手元で起動する版へ渡す環境変数。本番の像と同じ組（scripts/image.mjs: imageEnv）を、ビルド（NEXT_PUBLIC_ を埋め込む）と起動の
 * 両方へ渡す。管理画面（src/proxy.ts）の資格情報は撮影用の値で、capture/context.ts: openAdmin が同じ環境変数から読む。
 */
function frontendEnv(target, commit) {
  return {
    ...imageEnv(target, commit),
    ADMIN_BASIC_AUTH_USERNAME: "capture",
    ADMIN_BASIC_AUTH_PASSWORD: "capture",
  };
}

/** 版の src が読む環境変数（process.env.<名前>）のうち、env に無いもの。渡し漏れは、撮った画面が本番と違うことでしか分からないため。 */
function unpassedEnv(dir, env) {
  const names = new Set();
  for (const file of readdirSync(path.join(dir, "src"), { recursive: true })) {
    // テストはビルドに入らず、足場の文字列に書いた process.env を読まない。
    if (!/\.(ts|tsx)$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
    for (const [, name] of readFileSync(path.join(dir, "src", file), "utf-8").matchAll(
      /process\.env\.([A-Za-z_]\w*)/g,
    )) {
      names.add(name);
    }
  }
  return [...names].filter((name) => !(name in env));
}

const { values } = parseArgs({
  options: {
    script: { type: "string" },
    app: { type: "string", default: "worktree" },
    api: { type: "string" },
    backend: { type: "string", multiple: true, default: [] },
    size: { type: "string", default: "390x812" },
    theme: { type: "string" },
    out: { type: "string", default: path.join(os.tmpdir(), "ridecompass-capture") },
  },
});

const production = values.app === "production";
if (production && values.api) fail("--app production は本番の backend を使う（--api を外す）");
const api = values.api?.replace(/\/+$/, "") ?? "mock";
const mocked = !production && api === "mock";
if (values.backend.length > 0 && (production || mocked))
  fail("--backend は --api <backend のオリジン> と使う（選ばなかったパスは --api の backend が返す）");
const script = values.script ? path.resolve(values.script) : null;
if (script && !existsSync(script)) fail(`脚本が無い: ${script}`);
const [width, height] = values.size.split("x").map(Number);
if (!(width > 0 && height > 0)) fail(`--size は <幅>x<高さ>（例: 390x812）: ${values.size}`);
if (values.theme && !["light", "dark"].includes(values.theme)) fail(`--theme は light か dark: ${values.theme}`);
const label = { production: "本番", worktree: "作業ツリー" }[values.app] ?? values.app;
const out = path.join(
  path.resolve(values.out),
  fileName(label),
  `${width}x${height}${values.theme ? `-${values.theme}` : ""}`,
);
// 番号は撮るたびに1から振るので、前の実行の画像を残すと、段の少ない脚本で撮り直した後に前の段の画像が混ざる。
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** 宛先が 200 の JSON を返すまで待つ。休止中の宛先は、起きるまで応答を待たせるか、起動待ちの画面（HTML）を返す。 */
async function waitReady(name, url) {
  const deadline = Date.now() + WAKE_LIMIT_MS;
  const started = Date.now();
  let last = "応答なし";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      if (response.ok && (response.headers.get("content-type") ?? "").includes("json")) {
        console.log(`[capture] ${name} が応答した（${((Date.now() - started) / 1000).toFixed(1)}秒）`);
        return;
      }
      last = `${response.status} ${response.headers.get("content-type") ?? ""}`;
    } catch (error) {
      last = String(error.cause ?? error);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  fail(`${name} が ${WAKE_LIMIT_MS / 60_000} 分たっても起きない（${url} の最後の応答: ${last}）`);
}

prepareBrowser();

let serverDir = null;
let env = {};
if (!production) {
  const checkout =
    values.app === "worktree"
      ? {
          dir: frontendRoot,
          commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: frontendRoot, encoding: "utf-8" }).trim(),
          source: worktreeFingerprint(),
        }
      : checkoutRef(values.app);
  serverDir = checkout.dir;
  const target = mocked ? MOCKED_API : api;
  env = frontendEnv(target, checkout.commit);
  const unpassed = unpassedEnv(serverDir, env);
  if (unpassed.length > 0)
    fail(
      `frontend が読む環境変数を手元の版へ渡していない: ${unpassed.join(" / ")}（本番の像へも渡すものは scripts/image.mjs: imageEnv、撮影だけのものは scripts/capture.mjs: frontendEnv へ足す）`,
    );
  const build = JSON.stringify({ source: checkout.source, env });
  if (builtWith(serverDir) === build) {
    console.log(`[capture] ${label} の版の前のビルドを使う（API: ${mocked ? "モック" : target}）`);
  } else {
    console.log(`[capture] ${label} の版をビルドする（API: ${mocked ? "モック" : target}）`);
    if (run("npm", ["run", "build"], { cwd: serverDir, env }) !== 0) fail("ビルドに失敗");
    writeFileSync(path.join(serverDir, ".next", "capture-build"), build);
  }
}

let worktreeBackend = null;
if (values.backend.length > 0) {
  const origin = `http://localhost:${WORKTREE_BACKEND_PORT}`;
  // 前の実行の backend が残っていると、新しい backend は起きられないのに、残った方が応答して作業ツリーの backend として使われる。
  const occupied = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) }).then(
    () => true,
    () => false,
  );
  if (occupied) fail(`${origin} でほかの backend が応答している（前の実行の残りなら止めてから打ち直す）`);
  const log = path.join(os.tmpdir(), "ridecompass-capture-backend.log");
  console.log(`[capture] 作業ツリーの backend を起こす（${values.backend.join(" / ")}。ログ: ${log}）`);
  const logFd = openSync(log, "w");
  const server = spawn("python", ["scripts/serve_capture.py", WORKTREE_BACKEND_PORT], {
    cwd: path.join(path.dirname(frontendRoot), "backend"),
    stdio: ["ignore", logFd, logFd],
  });
  process.on("exit", () => server.kill());
  server.on("error", (error) => fail(`作業ツリーの backend を起こせない: ${error.message}`));
  // 応答を待つ間に止まれば、待ちの上限まで待たずに止める（起動の失敗はログにある）。
  server.on("exit", (code) => fail(`作業ツリーの backend が止まった（終了コード ${code}。ログ: ${log}）`));
  worktreeBackend = { origin, api, paths: values.backend };
  await waitReady("作業ツリーの backend", `${worktreeBackend.origin}/health`);
}

if (production) await waitReady("本番の frontend", `${productionOrigins.frontend}/api/version`);
if (!mocked && !production) await waitReady("backend", `${api}/health`);

const status = run(process.execPath, [playwright, "test", "-c", "playwright.capture.config.ts"], {
  env: {
    CAPTURE_BASE_URL: production ? productionOrigins.frontend : `http://localhost:${LOCAL_PORT}`,
    ...(serverDir ? { CAPTURE_LOCAL_PORT: LOCAL_PORT, CAPTURE_SERVER_DIR: serverDir } : {}),
    // 手元で起動する版は Playwright の webServer が起こし、環境変数を継ぐ。
    ...env,
    CAPTURE_OPTIONS: JSON.stringify({
      script,
      out,
      mocked,
      worktreeBackend,
      viewport: { width, height },
      theme: values.theme ?? null,
    }),
  },
});
process.exit(status);
