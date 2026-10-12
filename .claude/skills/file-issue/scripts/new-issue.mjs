// issue を起こす。本文の形（.claude/skills/file-issue/SKILL.md「issue の形」）と子の決まり（同「分ける」）を照らし、合えば GraphQL で
// 読む1回・作る1回（題名・本文・種類・親・欄）・前後の関係を張る1回（あれば）で作る。合わなければ作らずに理由を出して 1 で終わる。
// 使い方: node .claude/skills/file-issue/scripts/new-issue.mjs --title <題名> --body-file <本文のファイル> [--type <種類>]
//   [--parent <親>] [--origin <分割元>] [--blocked-by <前,...>] [--blocking <後,...>] [--size <S|M|L>] [--priority <高|中|低>] [--start <着手可能日時>]
//   欄だけ入れ直す: node .claude/skills/file-issue/scripts/new-issue.mjs --fill <番号> [--size ...] [--priority ...] [--start ...]
//   --parent は子（種類は親と同じ。条件と優先度・着手可能日時を持たない。孫は作らない）。--origin は要望ごとの切り出し（本文に「分割元: #N」を置く）。
import { readFileSync } from "node:fs";
import { bot, config, isMain } from "../../../../tools/flow-gate/src/bot.js";
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
    if (has) problems.push("子は完了の条件を持たない（親の行の下に「- 子: #番号」を付ける）");
    if (priority || start) problems.push("子に優先度・着手可能日時を入れない（ゲートが親の値を読む）");
  } else {
    if (!has) problems.push("完了の条件が無い");
    if (type !== config.dialogType && (!size || !priority)) problems.push("規模と優先度を入れる（--size・--priority）");
  }
  return [...problems, ...fieldProblems(config, fieldsOf({ size, priority, start }))];
}

// 要望ごとの切り出しの本文に「分割元: #N」の行を、要約の段落のあとへ置く（もうあれば置かない）。
export function withOrigin(body, origin) {
  const text = norm(body).trim();
  if (new RegExp(`^分割元: #${origin}\\s*$`, "m").test(text)) return text;
  const cut = text.indexOf("\n\n");
  return cut < 0 ? `${text}\n\n分割元: #${origin}` : `${text.slice(0, cut)}\n\n分割元: #${origin}${text.slice(cut)}`;
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

const fieldsOf = ({ size, priority, start }) => [["size", size], ["priority", priority], ["start", start]].filter(([, v]) => v);
const fieldLines = (values) => values.map(([key, value]) => `${config.fields[key].name}: ${value}`);
const numbers = (list) => (list ? list.split(",").map((n) => n.trim().replace(/^#/, "")) : []);
const messages = (errors) => errors.map((e) => e.message).join("・");
const reason = (e) => String(e.stderr || e.message).trim();

// 置き場へ GraphQL を1回打つ。無い issue を読んだときは gh が 1 で終わるが、応答の data と errors は読む。
function graphql(gh, query, variables = {}) {
  try {
    return JSON.parse(gh(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables })));
  } catch (e) {
    let reply = null;
    try {
      reply = JSON.parse(e.stdout);
    } catch {
      // 応答が JSON でない（5xx・通信の途切れ）。
    }
    if (reply?.data) return reply;
    throw e;
  }
}

// 作る前に読む1回: 置き場の ID・種類・親・前後の issue。番号は数字だけを通してから埋める。
function readQuery(parent, refs) {
  const issue = (alias, n, fields) => ` ${alias}:issue(number:${n}){${fields}}`;
  return "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id issueTypes(first:50){nodes{id name}}" +
    (parent ? issue("parent", parent, "id state issueType{name} parent{number}") : "") + refs.map((n) => issue(`i${n}`, n, "id")).join("") + "}}";
}

// 読んだ置き場から、作る入力と前後の関係の ID を決める。作れない理由があれば { stop } だけを返す（そのときは作らない）。
function plan(repo, opts, body, { blockedBy, blocking }) {
  const stop = [];
  const p = repo.parent;
  if (opts.parent && !p) stop.push(`親 #${opts.parent} が無い`);
  else if (p) {
    stop.push(...[p.parent && `親 #${opts.parent} は子なので、孫は作らない（同じ親 #${p.parent.number} の兄弟にする）`,
      p.state !== "OPEN" && `親 #${opts.parent} は閉じている`,
      !p.issueType && `親 #${opts.parent} に種類が無い（子の種類は親と同じにする）`,
      opts.type && p.issueType && opts.type !== p.issueType.name && `子の種類は親と同じ（${p.issueType.name}）`].filter(Boolean));
    // 種類に依らない照らしは読む前に済んでいるので、ここで増えるのは親の種類に合わない節だけ。
    stop.push(...issueProblems(body, { type: p.issueType?.name, child: true }));
  }
  const type = p ? p.issueType?.name : opts.type;
  const typeId = repo.issueTypes.nodes.find((t) => t.name === type)?.id;
  if (type && !typeId) stop.push(`種類「${type}」は置き場に無い（${repo.issueTypes.nodes.map((t) => t.name).join("・")}）`);
  const idOf = (n) => repo[`i${n}`]?.id;
  const missing = [...blockedBy, ...blocking].filter((n) => !idOf(n));
  if (missing.length) stop.push(`${missing.map((n) => `#${n}`).join("・")} が無い`);
  if (stop.length) return { stop };
  const values = fieldsOf(opts);
  const input = {
    repositoryId: repo.id, title: opts.title, body, issueTypeId: typeId,
    ...(p && { parentIssueId: p.id }), ...(values.length && { issueFields: fieldValues(config, values) }),
  };
  return { input, blockedBy: blockedBy.map(idOf), blocking: blocking.map(idOf) };
}

const CREATE = "mutation($in:CreateIssueInput!){createIssue(input:$in){issue{id number url}}}";
// 作られたかは、作る直前より後に動いた issue のうち新しく作られた順に、題名で探す（トークンの名義には頼らない）。
const MADE = "query($owner:String!,$name:String!,$since:DateTime!){repository(owner:$owner,name:$name){" +
  "issues(first:20,filterBy:{since:$since},orderBy:{field:CREATED_AT,direction:DESC}){nodes{number url title}}}}";

// 前後の関係（blocked by）を1回で張る。issue の組は [後, 先]。
function relate(gh, pairs) {
  const vars = Object.fromEntries(pairs.flatMap(([i, b], k) => [[`i${k}`, i], [`b${k}`, b]]));
  const query = `mutation(${pairs.map((_, k) => `$i${k}:ID!,$b${k}:ID!`).join(",")}){` +
    pairs.map((_, k) => `r${k}:addBlockedBy(input:{issueId:$i${k},blockingIssueId:$b${k}}){clientMutationId}`).join(" ") + "}";
  const reply = graphql(gh, query, vars);
  if (reply.errors?.length) throw new Error(messages(reply.errors));
}

// 照らして作る。出す行（out）と、1 で終える理由（err）を返す。now は作る直前の時刻（作られたかを確かめるときの起点）。
export function file(gh, opts, body, now = new Date()) {
  const [owner, name] = config.tasks.split("/");
  const refs = { blockedBy: numbers(opts["blocked-by"]), blocking: numbers(opts.blocking) };
  const all = [...refs.blockedBy, ...refs.blocking];
  const early = [all.some((n) => !/^\d+$/.test(n)) && "前後の issue は番号で書く（--blocked-by 5,6）",
    opts.parent && !/^\d+$/.test(opts.parent) && "親は番号で書く（--parent 5）",
    !opts.parent && !opts.type && "種類が無い（--type）"].filter(Boolean);
  // 子の種類は親から決まるので、親を読むまでは種類に依らない照らしだけを当てる。
  early.push(...issueProblems(body, { type: opts.parent ? undefined : opts.type, child: Boolean(opts.parent), size: opts.size, priority: opts.priority, start: opts.start }));
  if (early.length) return { out: [], err: `作らない: ${early.join("・")}` };
  let read;
  try {
    read = graphql(gh, readQuery(opts.parent, all), { owner, name });
  } catch (e) {
    return { out: [], err: `作らない: 置き場を読めなかった（${reason(e)}）` };
  }
  // 無い issue（NOT_FOUND）は plan が名指して断る。それ以外の誤りは読めなかったものとして扱う。
  const failed = (read.errors ?? []).filter((e) => e.type !== "NOT_FOUND");
  if (failed.length || !read.data?.repository) return { out: [], err: `作らない: 置き場を読めなかった（${messages(failed) || "置き場が無い"}）` };
  const planned = plan(read.data.repository, opts, body, refs);
  if (planned.stop) return { out: [], err: `作らない: ${planned.stop.join("・")}` };
  let made;
  try {
    const reply = graphql(gh, CREATE, { in: planned.input });
    // errors が付いていても issue が返っていれば作られている（作り直させない）。
    made = reply.data?.createIssue?.issue;
    if (!made) return { out: [], err: `作らなかった: ${messages(reply.errors ?? [])}` };
    if (reply.errors?.length) return { out: [made.url], err: `#${made.number} は作った（作り直さない）が、誤りが返った（${messages(reply.errors)}）。種類・親・欄を issue の画面で確かめる` };
  } catch (e) {
    return { out: [], err: unsure(gh, opts, { owner, name, now, why: reason(e) }) };
  }
  const out = [made.url, ...fieldLines(fieldsOf(opts))];
  const pairs = [...planned.blockedBy.map((b) => [made.id, b]), ...planned.blocking.map((k) => [k, made.id])];
  if (!pairs.length) return { out, err: null };
  try {
    relate(gh, pairs);
    return { out, err: null };
  } catch (e) {
    return { out, err: `#${made.number} は作った（作り直さない）。前後の関係を張れなかった（${reason(e)}）。次で張る:\n  ${relateCommand(made.number, opts)}` };
  }
}

// 前後の関係を手で張り直すコマンド（関係が無ければ空）。
const relateCommand = (number, opts) => (opts["blocked-by"] || opts.blocking ? `GH_TOKEN=$FLOW_BOT_TOKEN gh issue edit ${number} -R ${config.tasks}` +
  (opts["blocked-by"] ? ` --add-blocked-by ${opts["blocked-by"]}` : "") + (opts.blocking ? ` --add-blocking ${opts.blocking}` : "") : "");

// 作る要求が応答を返さずに落ちても、GitHub の側では作られていることがある。打ち直すと二重に作るので、作られたかを1回だけ読んで終える。
function unsure(gh, opts, { owner, name, now, why }) {
  const since = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  let found;
  try {
    found = graphql(gh, MADE, { owner, name, since }).data.repository.issues.nodes
      .find((i) => i.title.trim() === opts.title.trim());
  } catch (e) {
    return `作る要求が落ち（${why}）、作られたかも確かめられなかった（${reason(e)}）。打ち直す前に、` +
      `https://github.com/${config.tasks}/issues で題名「${opts.title}」の issue が無いことを確かめる`;
  }
  if (!found) return `作る要求が落ち（${why}）、作られていない。GitHub が戻ってから打ち直す`;
  const left = relateCommand(found.number, opts);
  return `作る要求は落ちた（${why}）が、#${found.number} は作られていた（作り直さない）: ${found.url}${left && `。前後の関係は次で張る:\n  ${left}`}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts?.fill) return fill(bot(), opts.fill, opts);
  if (!opts?.title || !opts["body-file"]) {
    console.error("使い方: node .claude/skills/file-issue/scripts/new-issue.mjs --title <題名> --body-file <本文のファイル> [--type <種類>] [--parent <親>] [--origin <分割元>] [--blocked-by <前,...>] [--blocking <後,...>] [--size <S|M|L>] [--priority <高|中|低>] [--start <着手可能日時>]");
    process.exit(2);
  }
  let body = readFileSync(opts["body-file"], "utf8");
  if (opts.origin) body = withOrigin(body, opts.origin);
  const { out, err } = file(bot(), opts, body);
  for (const line of out) console.log(line);
  if (err) {
    console.error(err);
    process.exit(1);
  }
}

// 欄を入れて、入れた欄を出す。落ちても issue はできているので、作り直させずに、作った番号と入れ直すコマンドを出して 1 で終わる。
function fill(gh, number, opts) {
  const values = fieldsOf(opts);
  const left = fillFields(gh, number, values);
  if (left) {
    console.error(left);
    process.exit(1);
  }
  for (const line of fieldLines(values)) console.log(line);
}

// 作った issue の欄（issue fields）を1回で入れる。全部入れば null、落ちたら作った番号と入れ直すコマンドの文。
export function fillFields(gh, number, values) {
  if (!values.length) return null;
  try {
    const id = JSON.parse(gh(["issue", "view", String(number), "-R", config.tasks, "--json", "id"])).id;
    const reply = graphql(gh, SET_FIELDS, { i: id, v: fieldValues(config, values) });
    if (reply.errors?.length) throw new Error(messages(reply.errors));
    return null;
  } catch (e) {
    return `#${number} は作った（作り直さない）。欄を入れられなかった（${reason(e)}）。欄は次で入れる:\n` +
      `  node .claude/skills/file-issue/scripts/new-issue.mjs --fill ${number} ${values.map(([k, v]) => `--${k} ${v}`).join(" ")}`;
  }
}

if (isMain(import.meta.url)) await main();
