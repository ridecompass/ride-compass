// issue を起こす。本文の形（.claude/skills/file-issue/SKILL.md「issue の形」）と子の決まり（同「分ける」）を照らし、合えば gh で作り、
// ゲートがボードへ入れるのを待って欄（規模・優先度・着手可能日時）を入れる。合わなければ作らずに理由を出して 1 で終わる。
// 使い方: node .claude/skills/file-issue/scripts/new-issue.mjs --title <題名> --body-file <本文のファイル> [--type <種類>]
//   [--parent <親>] [--origin <分割元>] [--blocked-by <前,...>] [--blocking <後,...>] [--size <S|M|L>] [--priority <高|中|低>] [--start <着手可能日時>]
//   --parent は子（種類は親と同じ。条件と優先度・着手可能日時を持たない。孫は作らない）。--origin は要望ごとの切り出し（本文に「分割元: #N」を置く）。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { conditions, norm } from "../../../../tools/flow-gate/src/questions.js";

const config = JSON.parse(readFileSync(new URL("../../../../tools/flow-gate/flow.config.json", import.meta.url), "utf8"));
// 畳んだ節の名前と順（2 は種類ごとに1つ）。
const SECTIONS = [["不具合: 起きていること", "要望: 困りごと", "保守: 背景", "調査: 明らかにしたいこと"], ["やること", "調べ方"], ["決めること"],
  ["完了の条件"], ["経緯"], ["規模と優先度の根拠"]];
const START = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/;

// 本文と欄が決まりに合わない所（空なら合う）。child は子として作るとき。
export function issueProblems(body, { type, child = false, size, priority, start }) {
  const text = norm(body).trim();
  const problems = [];
  if (!text || text.startsWith("<details>")) problems.push("本文の頭に、畳まない要約が無い");
  const names = [...text.matchAll(/^<details><summary>(.+?)<\/summary>/gm)].map((m) => m[1]);
  let at = -1;
  for (const name of names) {
    const k = SECTIONS.findIndex((s) => s.includes(name));
    if (k < 0) problems.push(`知らない節「${name}」（節は ${SECTIONS.map((s) => s.join("／")).join("・")} の順）`);
    else if (k <= at) problems.push(`節「${name}」の順か重なりが違う`);
    else at = k;
  }
  const head = names.find((n) => SECTIONS[0].includes(n));
  if (head && type && SECTIONS[0].some((n) => n.startsWith(`${type}:`)) && !head.startsWith(`${type}:`)) problems.push(`種類「${type}」に合わない節「${head}」`);
  const has = conditions(text).length > 0;
  if (child) {
    if (has) problems.push("子は完了の条件を持たない（親の行の下に「- 子: #番号」を付ける）");
    if (priority || start) problems.push("子に優先度・着手可能日時を入れない（ゲートが親の値を読む）");
  } else {
    if (!has) problems.push("完了の条件が無い");
    if (type !== config.dialogType && (!size || !priority)) problems.push("規模と優先度を入れる（--size・--priority）");
  }
  if (size && !["S", "M", "L"].includes(size)) problems.push(`規模「${size}」は S・M・L のどれか`);
  if (priority && !config.priorities.includes(priority)) problems.push(`優先度「${priority}」は ${config.priorities.join("・")} のどれか`);
  if (start && !START.test(start)) problems.push(`着手可能日時「${start}」は YYYY-MM-DD か YYYY-MM-DD HH:MM（日本時間）`);
  return problems;
}

// 要望ごとの切り出しの本文に「分割元: #N」の行を、要約の段落のあとへ置く（もうあれば置かない）。
export function withOrigin(body, origin) {
  const text = norm(body).trim();
  if (new RegExp(`^分割元: #${origin}\\s*$`, "m").test(text)) return text;
  const cut = text.indexOf("\n\n");
  return cut < 0 ? `${text}\n\n分割元: #${origin}` : `${text.slice(0, cut)}\n\n分割元: #${origin}${text.slice(cut)}`;
}

async function main() {
  const opts = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, "")] = argv[i + 1];
  if (!opts.title || !opts["body-file"]) {
    console.error("使い方: node .claude/skills/file-issue/scripts/new-issue.mjs --title <題名> --body-file <本文のファイル> [--type <種類>] [--parent <親>] [--origin <分割元>] [--blocked-by <前,...>] [--blocking <後,...>] [--size <S|M|L>] [--priority <高|中|低>] [--start <着手可能日時>]");
    process.exit(2);
  }
  if (!process.env.FLOW_BOT_TOKEN) {
    console.error("FLOW_BOT_TOKEN が無いので作らない（置き場へは hidakagit-bot の名義で書く）");
    process.exit(1);
  }
  const gh = (args, input) => execFileSync("gh", args, { input, encoding: "utf8", env: { ...process.env, GH_TOKEN: process.env.FLOW_BOT_TOKEN }, stdio: ["pipe", "pipe", "pipe"] });
  const [owner, name] = config.tasks.split("/");
  let type = opts.type;
  if (opts.parent) {
    const q = `query($n:Int!){repository(owner:"${owner}",name:"${name}"){issue(number:$n){state issueType{name} parent{number}}}}`;
    const p = JSON.parse(gh(["api", "graphql", "-F", `n=${opts.parent}`, "-f", `query=${q}`])).data.repository.issue;
    const stop = [p.parent && `親 #${opts.parent} は子なので、孫は作らない（同じ親 #${p.parent.number} の兄弟にする）`, p.state !== "OPEN" && `親 #${opts.parent} は閉じている`,
      type && type !== p.issueType?.name && `子の種類は親と同じ（${p.issueType?.name ?? "無し"}）`].filter(Boolean);
    if (stop.length) {
      console.error(`作らない: ${stop.join("・")}`);
      process.exit(1);
    }
    type = p.issueType?.name;
  }
  let body = readFileSync(opts["body-file"], "utf8");
  if (opts.origin) body = withOrigin(body, opts.origin);
  const problems = issueProblems(body, { type, child: Boolean(opts.parent), size: opts.size, priority: opts.priority, start: opts.start });
  if (!type) problems.push("種類が無い（--type）");
  if (problems.length) {
    console.error(`作らない: ${problems.join("・")}`);
    process.exit(1);
  }
  const url = gh(["issue", "create", "-R", config.tasks, "--type", type, "--title", opts.title, "--body-file", "-",
    ...(opts.parent ? ["--parent", opts.parent] : []), ...(opts["blocked-by"] ? ["--blocked-by", opts["blocked-by"]] : []),
    ...(opts.blocking ? ["--blocking", opts.blocking] : [])], body).trim();
  console.log(url);
  // 欄はボードの項目にあり、ゲートが種類でボードへ入れるまでは入らない（入るまで待って打ち直す。ふつうは数秒）。
  const board = config.boards[type === config.dialogType ? "dialog" : "actions"];
  const fields = [[config.fields.size, opts.size], [config.fields.priority, opts.priority], [config.fields.start, opts.start]].filter(([, v]) => v);
  for (const [field, value] of fields) {
    for (let tries = 1; ; tries++) {
      try {
        gh(["project", "item-edit", String(board), "--owner", config.owner, "--url", url, "--field", field, "--value", value]);
        console.log(`${field}: ${value}`);
        break;
      } catch (e) {
        if (tries >= 20) throw e;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
