// 担当のワークフロー（claude-task.yml）の後始末が、担当の実行のファイル（連携が書き出す発言の並び）を読む。担当が落ちても止められても走る。
// 担当が作業ブランチへ移っても振り出された版で動くよう、ワークフローは実行の始まりにこのファイルと条件の読み方（tools/flow-gate/src）を写して打つ。
// 使い方: node after.js <実装|検証> <実行のファイル> <手番の記録の URL（無ければ空）> <実行の URL> <読み始めの本文のファイル>
//   issue に書く終わりのコメントの本文を出す（担当の最後の発言・手番の記録・判定に断られた操作・実行・読み始め・読み始めの完了の条件）。
//   読み始め（環境変数 READ_FROM。担当の段が始まった時刻）より前のユーザーの文は、担当が読んでいる。ゲートはこの行で、まだ読まれていない文を見分け、
//   読み始めの完了の条件と今の本文を比べて、担当がその実行で約束を動かしたかを決める（tools/flow-gate/src/facts.js: readFacts）。
// 使い方: node after.js --quota <実行のファイル>
//   担当が Claude の利用の上限・認証で止まったときだけ 1 で終わる（見回りがこの段の失敗を読んで振り出しを止める。tools/flow-gate/src/patrol.js）。
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const read = (file) => (file && existsSync(file) ? readFileSync(file, "utf8") : "");
const [kind, file, log, url, startFile] = process.argv.slice(2);
const messages = read(file) ? JSON.parse(read(file)) : [];
const QUOTA = ["rate_limit", "billing_error", "authentication_failed", "oauth_org_not_allowed", "account_on_hold"];
if (kind === "--quota") process.exit(messages.some((m) => m?.type === "assistant" && QUOTA.includes(m.error)) ? 1 : 0);
const { conditions } = await import(pathToFileURL(`${process.env.FLOW_SRC}/questions.js`).href);

// 公開の Actions の記録には担当の発言を出さない（コメントは非公開の置き場へ書く）。GitHub のコメントの長さの上限（65536字）に収める。
const result = messages.findLast((m) => m?.type === "result");
const said = messages.filter((m) => m?.type === "assistant").map((m) => (m.message?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n").trim()).findLast(Boolean);
const words = (typeof result?.result === "string" && result.result.trim()) || said || "（無い）";
const denied = (result?.permission_denials ?? []).map((d) => `${d.tool_name}: ${String(d.tool_input?.command ?? d.tool_input?.file_path ?? d.tool_input?.url ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
// 読み始めの本文の完了の条件を、文とチェックだけの1行ずつで写す（読めなければ読めなかったと書く。ゲートは約束が動いたと読まない）。
const start = read(startFile) ? ["読み始めの完了の条件:", ...conditions(read(startFile)).map((c) => `- [${c.done ? "x" : " "}] ${c.text}`)] : ["読み始めの完了の条件: 読めなかった"];
const head = `### ${kind}担当の終わり\n\n要約（担当の最後の発言）:\n\n`;
const tail = ["", "", `手番の記録: ${log || "置けなかった（実行のファイルが無いか、置くのに失敗した）"}`,
  ...(denied.length ? ["", "判定に断られた操作:", ...denied.map((d) => `- ${d}`)] : []), "", `実行: ${url}`,
  ...(process.env.READ_FROM ? ["", `読み始め: ${process.env.READ_FROM}`] : []), "", ...start].join("\n");
console.log(head + words.split("\n").map((l) => `> ${l}`).join("\n").slice(0, 65536 - head.length - tail.length) + tail);
