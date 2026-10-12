// issue を起こす。本文の形（.claude/skills/file-issue/SKILL.md「issue の形」）と子の決まり（同「分ける」）を照らし、合えば gh で作り、
// issue の欄（規模・優先度・着手可能日時）を入れる。合わなければ作らずに理由を出して 1 で終わる。
// 使い方: node .claude/skills/file-issue/scripts/new-issue.mjs --title <題名> --body-file <本文のファイル> [--type <種類>]
//   [--parent <親>] [--origin <分割元>] [--blocked-by <前,...>] [--blocking <後,...>] [--size <規模>] [--priority <優先度>] [--start <着手可能日時>]
//   欄だけ入れ直す: node .claude/skills/file-issue/scripts/new-issue.mjs --fill <番号> [--size ...] [--priority ...] [--start ...]
//   規模と優先度の選択肢は設定（flow.config.json: fields）が持つ。
//   --parent は子（種類は親と同じ。子と孫の決まりは tools/flow-gate/src/family.js）。--origin は要望ごとの切り出し（本文に分割元の行を置く）。
import { readFileSync } from "node:fs";
import { bot, config, isMain, usage } from "../../../../tools/flow-gate/src/bot.js";
import { CHILD_FIELDS, NO_GRANDCHILD, childRule, makesGrandchild, originLine, originOf } from "../../../../tools/flow-gate/src/family.js";
import { SET_FIELDS, fieldProblems, fieldValues } from "../../../../tools/flow-gate/src/fields.js";
import { conditions, norm } from "../../../../tools/flow-gate/src/questions.js";

// 畳んだ節の名前と順（2 は種類ごとに1つ）。
const SECTIONS = [["不具合: 起きていること", "要望: 困りごと", "保守: 背景", "調査: 明らかにしたいこと"], ["やること", "調べ方"], ["決めること"],
  ["完了の条件"], ["経緯"], ["規模と優先度の根拠"]];

// 本文と欄が決まりに合わない所（空なら合う）。child は子として作るとき。
export function issueProblems(body, { type, child = false, size, priority, start }) {
  const text = norm(body).trim();
  const problems = [];
  if (!text || text.startsWith("<details>")) problems.push("本文の頭に、畳まない要約が無い");
  if (/^#{1,6} /m.test(text)) problems.push("見出し（#）は使わない（節は <details><summary> で畳む）");
  // 節の頭は <details> と <summary> が同じ行でも別の行でもよい。
  const names = [...text.matchAll(/^<details>\s*<summary>(.+?)<\/summary>/gm)].map((m) => m[1]);
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
    if (has) problems.push(childRule("<親>", "<この子>"));
    if (priority || start) problems.push(CHILD_FIELDS);
  } else {
    if (!has) problems.push("完了の条件が無い");
    if (type !== config.dialogType && (!size || !priority)) problems.push("規模と優先度を入れる（--size・--priority）");
  }
  return [...problems, ...fieldProblems(config, [["size", size], ["priority", priority], ["start", start]].filter(([, v]) => v))];
}

// 要望ごとの切り出しの本文に分割元の行を、要約の段落のあとへ置く（もうあれば置かない）。
export function withOrigin(body, origin) {
  const text = norm(body).trim();
  if (originOf(text) === Number(origin)) return text;
  const cut = text.indexOf("\n\n");
  return cut < 0 ? `${text}\n\n${originLine(origin)}` : `${text.slice(0, cut)}\n\n${originLine(origin)}${text.slice(cut)}`;
}

// 引数を読む。知らない口・値の無い口があれば null（打ち間違いで前提や親の無い issue を作らない）。
const KEYS = ["title", "body-file", "type", "parent", "origin", "blocked-by", "blocking", "size", "priority", "start", "fill"];
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || !KEYS.includes(key) || argv[i + 1] === undefined || argv[i + 1].startsWith("--")) return null;
    opts[key] = argv[i + 1];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts?.fill) return fill(bot(), opts.fill, opts);
  const choices = (key) => Object.keys(config.fields[key].options).join("|");
  if (!opts?.title || !opts["body-file"]) usage("node .claude/skills/file-issue/scripts/new-issue.mjs --title <題名> --body-file <本文のファイル> [--type <種類>] [--parent <親>] " +
    `[--origin <分割元>] [--blocked-by <前,...>] [--blocking <後,...>] [--size <${choices("size")}>] [--priority <${choices("priority")}>] [--start <着手可能日時>]`);
  const gh = bot();
  const { owner, name } = config.repos.tasks;
  let type = opts.type;
  if (opts.parent) {
    const q = `query($n:Int!){repository(owner:"${owner}",name:"${name}"){issue(number:$n){state issueType{name} parent{number}}}}`;
    const p = JSON.parse(gh(["api", "graphql", "-F", `n=${opts.parent}`, "-f", `query=${q}`])).data.repository.issue;
    const stop = [makesGrandchild(p.parent, false) && `親 #${opts.parent} は #${p.parent.number} の子です。${NO_GRANDCHILD}`, p.state !== "OPEN" && `親 #${opts.parent} は閉じている`,
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
  fill(gh, url.split("/").pop(), opts);
}

// 欄を入れて、入れた欄を出す。落ちても issue はできているので、作り直させずに、作った番号と入れ直すコマンドを出して 1 で終わる。
function fill(gh, number, opts) {
  const values = [["size", opts.size], ["priority", opts.priority], ["start", opts.start]].filter(([, v]) => v);
  const left = fillFields(gh, number, values);
  if (left) {
    console.error(left);
    process.exit(1);
  }
  for (const [key, value] of values) console.log(`${config.fields[key].name}: ${value}`);
}

// 作った issue の欄（issue fields）を1回で入れる。全部入れば null、落ちたら作った番号と入れ直すコマンドの文。
export function fillFields(gh, number, values) {
  if (!values.length) return null;
  try {
    const id = JSON.parse(gh(["issue", "view", String(number), "-R", config.tasks, "--json", "id"])).id;
    gh(["api", "graphql", "--input", "-"], JSON.stringify({ query: SET_FIELDS, variables: { i: id, v: fieldValues(config, values) } }));
    return null;
  } catch (e) {
    return `#${number} は作った（作り直さない）。欄を入れられなかった（${String(e.stderr || e.message).trim()}）。欄は次で入れる:\n` +
      `  node .claude/skills/file-issue/scripts/new-issue.mjs --fill ${number} ${values.map(([k, v]) => `--${k} ${v}`).join(" ")}`;
  }
}

if (isMain(import.meta.url)) await main();
