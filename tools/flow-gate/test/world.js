// ゲートのテストの偽の世界: GitHub の代わりの world（置き場の issue・作業ブランチの PR と検査の実行・担当の実行）と、出来事（ev）・問いと答えの組み立て、
// 回答フォームへのつなぎ。出来事は受け箱（src/inbox.js: Inbox）に入れて本物と同じ処理（src/flow.js: handle）で動かす。
import { config as loaded } from "../src/bot.js";
import { endHead, readFromLine, startBlock } from "../src/facts.js";
import { formed as FORMED } from "./forms.js";
import { handle } from "../src/flow.js";
import { answerForm } from "../src/form.js";
import { Inbox } from "../src/inbox.js";
import { answerBody, askText, droppedQuestion, latestQuestion, withValues } from "../src/questions.js"; // ゲートの問いと答えの形を入力に使う

export const config = { ...loaded, slots: { 実装: 2, 検証: 1 } };
const tasks = { full_name: config.tasks };
const code = { full_name: config.code };
const names = (list) => ({ nodes: list.map((name) => ({ name })) });
// コメントの時刻は並びの順（k 番目は k 秒）。書いた人は、置いたときに決めたもの（i.by）か、答え（## 回答）ならユーザー、ゲートのラベルの問いならゲート、ほかは Claude。
export const T = (k) => new Date(Date.UTC(2026, 9, 11) + k * 1000).toISOString();
const author = (i, k) => i.by[k] ?? (i.comments[k].startsWith("## 回答") ? config.user
  : config.questionForms[/^## 問い（(.+)）/.exec(i.comments[k])?.[1]]?.by === "ゲート" ? config.gateBot : config.claude);
// 担当の終わりのコメント（.github/claude-task/after.js）。start は担当が読み始めたときのコメントの数（それより前を読んでいる）。before は読み始めの本文で、
// その完了の条件を写す（無ければ写さない）。
export const END = (start, kind = "実装", before = "") =>
  [`${endHead(kind)}\n\n要約（担当の最後の発言）:\n\n> 読んだ\n\n${readFromLine(T(start - 0.5))}`, ...(before ? ["", startBlock(before)] : [])].join("\n");
// コミットに付いたワークフローの実行（check suite）。置いたときの値（SUCCESS・FAILURE・CANCELLED・PENDING）を、GitHub の status と conclusion の形にする
// （PENDING は走っている）。state は検査のワークフロー（config.checks.workflow）の最も新しい実行（at に始まった）、before はそれより前に同じコミットで始まった検査の実行
// （古い順。説明文を書き直して打ち直したもの等）。
const outcome = (s) => (s === "PENDING" ? { status: "IN_PROGRESS", conclusion: null } : { status: "COMPLETED", conclusion: s });
const suite = (file, s, at) => ({ ...outcome(s), createdAt: at, workflowRun: { file: { path: `.github/workflows/${file}` } } });
const suites = (state, { at = T(-1), before = [] } = {}) => ({ nodes: [
  ...before.map((s, k) => suite(config.checks.workflow, s, new Date(Date.parse(at) - (before.length - k) * 1000).toISOString())),
  ...(state ? [suite(config.checks.workflow, state, at)] : [])] });
const TYPES = ["保守", "不具合", "要望", "調査", config.dialogType];
const LOGIN = Object.fromEntries(Object.entries(config.ids).map(([login, id]) => [id, login]));

export function world(list, { workflow = "active", last = [], steps = [] } = {}) {
  const w = { issues: new Map(), runs: [], writes: [], olderReads: 0 }; // olderReads は、最近のコメントより前までさかのぼって読んだ回数
  for (const i of list) w.issues.set(i.n, { state: "OPEN", reason: null, body: "- [ ] 作る\n", author: config.user, type: null, assignees: [], blockedBy: [],
    comments: [], by: [], closedAt: null, status: null, run: null, priority: null, start: null, parent: null, labels: [], pr: null, ...i });
  w.at = (n) => w.issues.get(n);
  // issue の欄（src/facts.js: FIELDS の形）。単一選択は name、文字は value。
  const f = config.fields;
  const fields = (i) => ({ nodes: [[f.status, i.status], [f.run, i.run], [f.priority, i.priority], [f.start, i.start]].filter(([, v]) => v)
    .map(([field, v]) => ({ ...(field.id && !field.options ? { value: v } : { name: v }), field: { name: field.name } })) });
  const near =(n) => ({ number: n, state: w.at(n).state, stateReason: w.at(n).reason });
  const blocked = (i) => ({ nodes: i.blockedBy.map(near) });
  const children = (i) => ({ nodes: [...w.issues.values()].filter((k) => k.parent === i.n).map((k) => near(k.n)) });
  // 矢印1本でつながる issue（src/facts.js: relationsOf の形）。
  const relations = (i) => {
    const p = i.parent && w.at(i.parent);
    return { blockedBy: blocked(i), subIssues: children(i), parent: p && { ...near(p.n), body: p.body, labels: names(p.labels), issueFieldValues: fields(p) } };
  };
  // PR は、置いたときに決めた時刻（p.created・p.mergedAt）が無ければ、どのコメントより前に作られ、マージされた。
  const pull = (i, p) => ({ id: `PR${i.n}`, state: p.state ?? "OPEN", isDraft: p.draft, mergeable: p.mergeable ?? "MERGEABLE", merged: Boolean(p.merged), createdAt: p.created ?? T(-1),
    mergedAt: p.mergedAt ?? (p.merged ? T(-1) : null),
    commits: { nodes: [{ commit: { oid: `c${i.n}`, committedDate: "2026-10-11T00:00:00Z", checkSuites: suites(p.checks, { at: p.checksAt ?? p.created, before: p.checksBefore }) } }] },
    timelineItems: { nodes: p.drafted ? [{ createdAt: "2026-10-11T01:00:00Z" }] : [] } });
  // master の push で動いた検査の実行（REST の形で新しい順）は、マージした PR のマージのコミットの検査（置いたときの p.mergeChecks。無ければまだ一覧に出ていない）。
  // 実行はマージした時刻（p.mergedAt。無ければどのコメントより前で、番号の順）に作られた。
  const masterRuns = () => [...w.issues.values()].filter((i) => i.pr?.merged && i.pr.mergeChecks)
    .map((i) => ({ display_title: `tasks#${i.n}: 直した (#99)`, created_at: i.pr.mergedAt ?? new Date(Date.parse(T(-2)) + i.n).toISOString(),
      ...Object.fromEntries(Object.entries(outcome(i.pr.mergeChecks)).map(([k, v]) => [k, v?.toLowerCase() ?? null])) }))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const issueOf = (id) => w.at(Number(id.slice(1)));
  // 置き場のラベル: 決まったもの（急ぎ・開発機で作業中・問いのラベル）と、issue に付いたもの。
  const repoLabels = () => [...new Set([config.urgentLabel, config.devLabel, "要確認", ...Object.keys(config.questionForms).map((k) => `問い: ${k}`),
    ...[...w.issues.values()].flatMap((k) => k.labels)])];
  // ゲートの書き込み（src/gate.js: settle）。1回の要求に並べた書き込みを、並べた順に当てる。
  const WRITE = {
    updateIssue(x) {
      const i = issueOf(x.id);
      if (x.stateInput?.value === "OPEN") Object.assign(i, { state: "OPEN", reason: null, closedAt: null });
      if ("issueTypeId" in x) i.type = x.issueTypeId && x.issueTypeId.slice(1);
      if (x.body !== undefined) (i.body = x.body, w.writes.push(["本文", i.n]));
      if (x.assigneeIds) i.assignees = x.assigneeIds.map((id) => LOGIN[id]);
      if (x.labelIds) i.labels = x.labelIds.map((id) => id.slice(1));
      for (const u of x.issueFieldUpdates ?? []) i[Object.keys(f).find((k) => f[k].name === u.fieldName)] = u.operation === "SET" ? u.value : null;
    },
    addComment(x, who) {
      const i = issueOf(x.subjectId);
      i.by[i.comments.length] = who;
      i.comments.push(x.body);
      w.writes.push(["コメント", i.n, x.body.split("\n")[0]]);
    },
    closePullRequest: (x) => (w.at(Number(x.pullRequestId.slice(2))).pr.state = "CLOSED", w.writes.push(["PR を閉じる", Number(x.pullRequestId.slice(2))])),
    markPullRequestReadyForReview: (x) => void (w.at(Number(x.pullRequestId.slice(2))).pr.draft = false),
    addLabelsToLabelable: (x) => void (issueOf(x.labelableId).labels.push(...x.labelIds.map((id) => id.slice(1)))),
    removeLabelsFromLabelable(x) {
      const i = issueOf(x.labelableId);
      i.labels = i.labels.filter((n) => !x.labelIds.includes(`L${n}`));
    },
    closeIssue(x) {
      const i = issueOf(x.issueId);
      Object.assign(i, { state: "CLOSED", reason: x.stateReason, closedAt: T(i.comments.length - 0.5) });
    },
  };
  // who は書いた名義（ゲートは App、回答フォームはユーザー）。本物と同じく、宣言したのに使わない変数がある問い合わせは断る。
  const gql = async (q, v, who = config.gateBot) => {
    const header = /^[^{]*/.exec(q)[0];
    for (const [, name] of header.matchAll(/\$(\w+):/g)) if (!new RegExp(`\\$${name}\\b`).test(q.slice(header.length))) throw new Error(`Variable $${name} is declared but not used`);
    if (q.startsWith("mutation(") && who === config.gateBot) w.mutations = (w.mutations ?? 0) + 1; // ゲートの書き込みの要求の数
    if (q.startsWith("mutation(") && q.includes("w0:")) {
      for (const [, k, name] of q.matchAll(/w(\d+):(\w+)\(/g)) WRITE[name](v[`v${k}`], who);
      return {};
    }
    if (q.includes("removeSubIssue")) {
      w.at(Number(v.c.slice(1))).parent = null;
      w.writes.push(["親子を外す", Number(v.c.slice(1))]);
      return void WRITE.addComment({ subjectId: v.c, body: v.b }, config.gateBot);
    }
    if (q.includes("comments(first:100,after:$a)")) return w.olderReads++, { repository: { issue: { comments: { pageInfo: { hasNextPage: false }, nodes: w.at(v.n).comments.map((body) => ({ body })) } } } };
    if (q.includes("timelineItems(since:")) { // ユーザーの欄の変更と開き直し（i.moves: [だれが, 何番目のコメントの時刻の直後か, 欄の名前（開き直しなら無し）]）
      const nodes = (w.at(v.n).moves ?? []).filter(([, k]) => T(k + 0.5) > v.s).map(([login, , field]) => ({ actor: { login }, ...(field ? { issueField: { name: field } } : {}) }));
      return { repository: { issue: { timelineItems: { pageInfo: { hasNextPage: false }, nodes } } } };
    }
    if (q.includes("CROSS_REFERENCED_EVENT")) { // 移管先の候補（src/facts.js: movedOf）。issue は置いたときの時刻（k.created）か、どのコメントより前にできた
      const i = w.at(v.n);
      const node = (k) => ({ createdAt: k.created ?? T(-10), body: k.body });
      const kids = (p) => [...w.issues.values()].filter((k) => k.parent === p).map(node);
      return { repository: { issue: { subIssues: { nodes: kids(i.n) }, parent: i.parent && { subIssues: { nodes: kids(i.parent) } },
        timelineItems: { nodes: [...w.issues.values()].filter((k) => k.n !== i.n && k.body.includes(`#${i.n}`)).map((k) => ({ source: node(k) })) } } } };
    }
    if (q.includes("c:issue(number:$c)")) return { repository: { p: { parent: w.at(v.p).parent && { number: w.at(v.p).parent } }, c: { subIssues: children(w.at(v.c)) } } };
    if (q.includes("issues(states:OPEN")) return { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [...w.issues.values()].filter((i) => i.state === "OPEN")
      .map((i) => ({ number: i.n, state: i.state, issueType: i.type && { name: i.type }, labels: names(i.labels), assignees: { nodes: i.assignees.map((login) => ({ login })) },
        issueFieldValues: fields(i), ...relations(i) })) } } };
    if (q.includes("bodyHTML")) { // 回答フォームの読み（src/form.js）
      const i = w.at(v.i);
      return { repository: { labels: { nodes: repoLabels().map((name) => ({ id: `L${name}`, name })) }, issue: { id: `I${i.n}`, title: "タスク", url: `https://github.test/${i.n}`,
        // 本文の頭の回答のボタンは、GitHub が描く形（段落の中のリンクの付いた画像）にする。
        body: i.body, bodyHTML: i.body.replace(/^<!-- flow-gate -->\n\[!\[回答する\]\(([^)]*)\)\]\(([^)]*)\)\n<!-- \/flow-gate -->\n/, '<p><a href="$2" rel="nofollow"><img src="$1"></a></p>'), labels: names(i.labels),
        comments: { nodes: i.comments.map((body, k) => ({ body, bodyHTML: body, url: "https://github.test/c", createdAt: T(k), author: { login: author(i, k).replace(/\[bot\]$/, "") } })) } } } };
    }
    if (q.includes("t:repository")) {
      const i = w.at(v.n);
      // 閉じた時刻を置いていない閉じた issue は、今あるコメントのあとに閉じた。
      const closedAt = i.state === "CLOSED" ? (i.closedAt ?? T(i.comments.length - 0.5)) : null;
      // GraphQL は App の書き手の名前を [bot] の付かない形で返す。コメントの時刻は並びの順。
      const comments = i.comments.map((body, k) => ({ body, createdAt: T(k), author: { login: author(i, k).replace(/\[bot\]$/, "") } })).slice(-40);
      return { t: { issueTypes: { nodes: TYPES.map((name) => ({ id: `T${name}`, name })) }, labels: { nodes: repoLabels().map((name) => ({ id: `L${name}`, name })) },
        issue: { id: `I${i.n}`, state: i.state, stateReason: i.reason, closedAt, body: i.body, author: { login: i.author }, issueType: i.type && { name: i.type },
          assignees: { nodes: i.assignees.map((login) => ({ login })) }, labels: names(i.labels), ...relations(i), comments: { totalCount: i.comments.length, nodes: comments }, issueFieldValues: fields(i),
          blocking: { nodes: [...w.issues.values()].filter((k) => k.blockedBy.includes(v.n)).map((k) => ({ number: k.n, state: k.state })) },
          timelineItems: { nodes: (i.typeChanges ?? []).map(([a, b]) => ({ prevIssueType: { name: a }, issueType: { name: b } })) } } },
      c: { pullRequests: { nodes: i.pr ? [pull(i, i.pr)] : [] } } };
    }
    throw new Error(`知らない問い合わせ: ${q.slice(0, 80)}`);
  };
  const rest = async (method, path, body, who = config.gateBot) => {
    let m;
    if (path.endsWith(`/workflows/${config.workflow}`)) return { state: workflow };
    if (path.includes("/runs?per_page=100")) return { workflow_runs: [...w.runs, ...last].reverse().map((r) => ({ id: r.id, display_title: r.display_title ?? "#99 実装",
      status: r.status ?? "completed", conclusion: r.conclusion ?? null, created_at: r.created_at ?? new Date().toISOString(), updated_at: r.updated_at ?? new Date().toISOString() })) };
    if (path.endsWith("/jobs")) return { jobs: [{ steps }] };
    if (path.includes(`/workflows/${config.checks.workflow}/runs?branch=${config.base}&event=push`)) return { workflow_runs: masterRuns() };
    if (path.endsWith("/dispatches")) { // 本物と同じく、振り出すと実行の申し込みの知らせが届く
      const r = { id: 100 + w.runs.length, display_title: `#${body.inputs.issue} ${body.inputs.kind} ${body.inputs.key}`, status: "queued" };
      w.runs.push(r);
      return void (await w.inbox.push(...ev.run(r, "requested")));
    }
    if ((m = /\/actions\/runs\/(\d+)\/cancel$/.exec(path))) {
      if (w.ended?.includes(Number(m[1]))) throw new Error(`GitHub POST ${path}: 409 {"message":"Cannot cancel a workflow run that is completed."}`);
      return void w.writes.push(["取り消し", Number(m[1])]);
    }
    // 回答フォームは、答えとラベルの付け外しをユーザーの名義で書く（src/form.js）。
    if ((m = /\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(path))) {
      const i = w.at(Number(m[1]));
      return void (i.labels = m[2] ? i.labels.filter((l) => l !== decodeURIComponent(m[2])) : [...i.labels, ...body.labels]);
    }
    const i = w.at(Number(/\/issues\/(\d+)/.exec(path)[1]));
    if (path.endsWith("/comments")) return void (i.by[i.comments.length] = who, i.comments.push(body.body), w.writes.push(["コメント", i.n, body.body.split("\n")[0]]));
    throw new Error(`知らない要求: ${method} ${path}`);
  };
  w.gh = { gql, rest };

  // 置き場は Durable Object の置き場と同じ口（get・put・delete・前方一致の list）をメモリで持つ。受け箱と見回りは本物。
  const memory = new Map();
  const storage = { get: async (k) => memory.get(k), put: async (k, v) => void memory.set(k, v), delete: async (k) => [k].flat().forEach((x) => memory.delete(x)),
    list: async ({ prefix }) => new Map([...memory].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))) };
  w.inbox = new Inbox(storage, (name, payload) => (w.fail ? Promise.reject(w.fail) : handle(w.gh, { inbox: w.inbox }, config, name, payload)));
  w.push = ([name, payload]) => w.inbox.push(name, payload);
  w.send = async (event) => (await w.push(event), w.inbox.drain(config.retries));
  w.titles = () => w.runs.map((r) => r.display_title.split(" ").slice(0, 2).join(" "));
  w.run = (n) => w.runs.findLast((r) => r.display_title.startsWith(`#${n} `));
  return w;
}
export const ev = {
  // 実行の申し込み・始まり・終わりの知らせ。実行の status は知らせのとおりに進む（終わったあとに届いた始まりの知らせでは戻らない）。
  run: (r, action) => (r.status = r.status === "completed" || action === "completed" ? "completed" : action === "in_progress" ? "in_progress" : r.status ?? "queued", ["workflow_run", { action, sender: { login: config.gateBot }, repository: code, workflow_run: { id: r.id, path: `.github/workflows/${config.workflow}`, display_title: r.display_title } }]),
  ci: (branch, title = "検査") => ["workflow_run", { action: "completed", sender: { login: config.user }, repository: code,
    workflow_run: { id: 1, path: ".github/workflows/ci.yml", head_branch: branch, display_title: title } }],
  // master の検査の実行（実行の名前は、マージのコミットの件名「tasks#<番号>: …」）。
  merge: (n) => ev.ci(config.base, `tasks#${n}: 直した (#99)`),
  comment: (n, login = config.user) => ["issue_comment", { action: "created", sender: { login }, issue: { number: n }, repository: tasks }],
  issue: (n, action, login = config.user, more = {}) => ["issues", { action, sender: { login }, issue: { number: n, body: more.body }, changes: more.changes, repository: tasks }],
  pr: (n, action) => ["pull_request", { action, sender: { login: config.user }, repository: code, pull_request: { head: { ref: `${config.branchPrefix}${n}` } } }],
  move: (n) => ["issues", { action: "field_added", sender: { login: config.user }, issue: { number: n }, repository: tasks }],
  schedule: () => ["schedule", {}],
  sub: (p, c, action = "sub_issue_added") => ["sub_issues", { action, sender: { login: config.claude }, repository: tasks,
    parent_issue: { number: p, node_id: `I${p}` }, sub_issue: { number: c, node_id: `I${c}` } }],
};
export const head = (i) => i.comments.at(-1)?.split("\n")[0] ?? null;
export const ASK_DROPPED = (numbers) => askText("続行", config.questionForms, [], droppedQuestion(numbers)); // ゲートが出す続行の問い
export const QUESTION = FORMED("判断", "どちらにしますか？", [["案A", "推奨", "早い"], ["案B", "理由", "安い"]]); // 形どおりの判断の問い
// 問いへの答え（答えの組み立ての持ち主で作る）。
export const REPLY = (question, next, text = "", plan = "") => answerBody(latestQuestion([question], config.questionForms), { next, text, plan });
export const ANSWER = (next, text = "") => REPLY(QUESTION, next, text);
// ユーザーが回答フォームで、確かめることを全部 YES にして続けた（値は本文の約束へ、答えはコメントへ）。
export const CONFIRMED = (i) => {
  const q = latestQuestion(i.comments, config.questionForms);
  const yes = q.rows.map((r) => r.text);
  Object.assign(i, { body: withValues(i.body, q, yes) }).comments.push(answerBody(q, { next: "続ける", yes }));
};
export const CONFIRM = "- [x] 作る\n- [ ] 見た目\n  - 確かめる: ユーザー\n";
export const ASKED = (kind) => askText(kind, config.questionForms, [{ text: "見た目" }]); // ゲートが出す問い（確かめは CONFIRM のユーザーが確かめる条件を並べる）

// ゲートのコメントだけを見る（担当の終わりのコメントは担当のワークフローが書く）。
export const said = (i) => i.comments.filter((c) => !/^### \S+担当の終わり/.test(c)).at(-1)?.split("\n")[0] ?? null;

// 回答フォームは App の名義で読み、答えはユーザーの名義（FORM_TOKEN）で書く。GitHub への要求は world へつなぐ。
const key = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]);
export const env = { APP_ID: 1, APP_KEY: Buffer.from(await crypto.subtle.exportKey("pkcs8", key.privateKey)).toString("base64"), FORM_TOKEN: "user" };
export function connect(w) {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace("https://api.github.com", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    const reply = (x, type = "application/json") => new Response(x == null ? null : type === "application/json" ? JSON.stringify(x) : x, { status: x == null ? 204 : 200, headers: { "content-type": type } });
    if (path.startsWith("/app/installations/")) return reply({ token: "app", expires_at: "2099-01-01T00:00:00Z" });
    if (path === "/graphql") return reply({ data: await w.gh.gql(body.query, body.variables, init.headers?.authorization === `Bearer ${env.FORM_TOKEN}` ? config.user : config.gateBot) });
    if (path === "/markdown") return reply(`<p>${body.text}</p>`, "text/html");
    // 回答フォームは答えをユーザーの名義（FORM_TOKEN）で書く。
    return reply(await w.gh.rest(init.method, path, body, init.headers?.authorization === `Bearer ${env.FORM_TOKEN}` ? config.user : config.gateBot));
  };
}
export const url = (n) => `${config.urls.form}/answer?issue=${n}`;
export const open = (n) => answerForm(new Request(url(n)), env, config);
// ブラウザと同じく、開いたページの隠しの欄（問いの文・回答内容の行）と、最初から選ばれた丸（YES／NO）と、選んだ値を送る。
export async function answer(n, picks) {
  const html = await (await open(n)).text();
  const form = new FormData();
  for (const [, type, name, value, checked] of html.matchAll(/<input type="(hidden|radio)" name="(\w+)" value="([^"]*)"( checked)?>/g)) {
    if (type === "hidden" || checked) form.set(name, value.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c)));
  }
  for (const [k, v] of Object.entries(picks)) (form.delete(k), [v].flat().forEach((x) => form.append(k, x)));
  return (await answerForm(new Request(url(n), { method: "POST", body: form }), env, config)).json();
}
