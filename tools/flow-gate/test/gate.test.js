// ゲートを入口から、tasks#788 の要求とユーザーと決めた約束（tasks#799）で確かめる。出来事は受け箱（src/inbox.js: Inbox）に入れて本物と同じ処理
// （src/flow.js: handle）で、回答フォームは HTTP の要求（src/form.js: answerForm）で動かし、ボード・コメント・本文・PR・ラベル・実行・状況の更新を見る。
// 期待は要求の文から書く（各行・各 assert の名前）。GitHub の代わりの world は、置き場の issue・作業ブランチの PR と検査の実行・担当の実行を持つ。
import assert from "node:assert/strict";
import test from "node:test";
import { config as loaded } from "../src/bot.js";
import { endHead, readFromLine, startBlock } from "../src/facts.js";
import { NO_GRANDCHILD, originLine } from "../src/family.js";
import { SKELETON, formed as FORMED } from "./forms.js";
import { handle } from "../src/flow.js";
import { answerForm } from "../src/form.js";
import { Inbox, nextAlarm } from "../src/inbox.js";
import { APPLIED, answerBody, askDropped, askText, checkQuestion, conditions, droppedQuestion, latestQuestion, loadForms, withButton } from "../src/questions.js"; // 本物のボタンと、ゲートの問いの形を入力に使う

const config = { ...loaded, slots: { 実装: 2, 検証: 1 } };
const tasks = { full_name: config.tasks };
const code = { full_name: config.code };
const names = (list) => ({ nodes: list.map((name) => ({ name })) });
// コメントの時刻は並びの順（k 番目は k 秒）。書いた人は、置いたときに決めたもの（i.by）か、答え（## 回答）ならユーザー、ほかは Claude。
const T = (k) => new Date(Date.UTC(2026, 9, 11) + k * 1000).toISOString();
const author = (i, k) => i.by[k] ?? (i.comments[k].startsWith("## 回答") ? config.user : config.claude);
// 担当の終わりのコメント（.github/claude-task/after.js）。start は担当が読み始めたときのコメントの数（それより前を読んでいる）。before は読み始めの本文で、
// その完了の条件を写す（無ければ写さない）。
const END = (start, kind = "実装", before = "") =>
  [`${endHead(kind)}\n\n要約（担当の最後の発言）:\n\n> 読んだ\n\n${readFromLine(T(start - 0.5))}`, ...(before ? ["", startBlock(before)] : [])].join("\n");
// 検査の実行（check suite）。置いたときの値（SUCCESS・FAILURE・PENDING）を、GitHub の status と conclusion の形にする。running は、ほかに走っている実行。
const suites = (state, running = false) => ({ nodes: [...(state ? [state === "PENDING" ? { status: "IN_PROGRESS", conclusion: null } : { status: "COMPLETED", conclusion: state }] : []),
  ...(running ? [{ status: "IN_PROGRESS", conclusion: null }] : [])].map((s, k) => ({ ...s, workflowRun: { databaseId: k + 1 } })) });
const TYPES = ["保守", "不具合", "要望", "調査", config.dialogType];
const LOGIN = Object.fromEntries(Object.entries(config.ids).map(([login, id]) => [id, login]));

function world(list, { workflow = "active", last = [], steps = [] } = {}) {
  const w = { issues: new Map(), runs: [], writes: [], requests: 0 };
  for (const i of list) w.issues.set(i.n, { state: "OPEN", reason: null, body: "- [ ] 作る\n", author: config.user, type: null, assignees: [], blockedBy: [],
    comments: [], by: [], closedAt: null, status: null, run: null, priority: null, start: null, parent: null, labels: [], pr: null, ...i });
  w.at = (n) => w.issues.get(n);
  // issue の欄（src/facts.js: FIELDS の形）。単一選択は name、文字は value。
  const f = config.fields;
  const fields = (i) => ({ nodes: [[f.status, i.status], [f.run, i.run], [f.priority, i.priority], [f.start, i.start]].filter(([, v]) => v)
    .map(([field, v]) => ({ ...(field.id && !field.options ? { value: v } : { name: v }), field: { name: field.name } })) });
  const near = (n) => ({ number: n, state: w.at(n).state, stateReason: w.at(n).reason });
  const blocked = (i) => ({ nodes: i.blockedBy.map(near) });
  const children = (i) => ({ nodes: [...w.issues.values()].filter((k) => k.parent === i.n).map((k) => near(k.n)) });
  // 矢印1本でつながる issue（src/facts.js: relationsOf の形）。
  const relations = (i) => {
    const p = i.parent && w.at(i.parent);
    return { blockedBy: blocked(i), subIssues: children(i), parent: p && { ...near(p.n), body: p.body, labels: names(p.labels), issueFieldValues: fields(p) } };
  };
  // PR は、置いたときに決めた時刻（p.created・p.mergedAt）が無ければ、どのコメントより前に作られた。
  const pull = (i, p) => ({ id: `PR${i.n}`, state: p.state ?? "OPEN", isDraft: p.draft, merged: Boolean(p.merged), createdAt: p.created ?? T(-1), mergedAt: p.mergedAt ?? null,
    mergeCommit: { oid: p.sha ?? `m${i.n}`, checkSuites: suites(p.mergeChecks, p.mergeRunning) },
    commits: { nodes: [{ commit: { oid: `c${i.n}`, committedDate: "2026-10-11T00:00:00Z", checkSuites: suites(p.checks) } }] },
    timelineItems: { nodes: p.drafted ? [{ createdAt: "2026-10-11T01:00:00Z" }] : [] } });
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
    addComment(x) {
      const i = issueOf(x.subjectId);
      i.by[i.comments.length] = config.gateBot;
      i.comments.push(x.body);
      w.writes.push(["コメント", i.n, x.body.split("\n")[0]]);
    },
    closePullRequest: (x) => (w.at(Number(x.pullRequestId.slice(2))).pr.state = "CLOSED", w.writes.push(["PR を閉じる", Number(x.pullRequestId.slice(2))])),
    markPullRequestReadyForReview: (x) => void (w.at(Number(x.pullRequestId.slice(2))).pr.draft = false),
    closeIssue(x) {
      const i = issueOf(x.issueId);
      Object.assign(i, { state: "CLOSED", reason: x.stateReason, closedAt: T(i.comments.length - 0.5) });
    },
  };
  const gql = async (q, v) => {
    w.requests++;
    if (q.includes("addLabelsToLabelable") || (q.includes("c:addComment") && !q.includes("w0:"))) { // 回答フォームの送信（ユーザーの名義）
      const i = issueOf(v.i);
      i.by[i.comments.length] = config.user;
      i.comments.push(v.b);
      w.writes.push(["コメント", i.n, v.b.split("\n")[0]]);
      if (q.includes("a:addLabelsToLabelable")) i.labels = [...i.labels, ...v.a.map((id) => id.slice(1))];
      if (q.includes("r:removeLabelsFromLabelable")) i.labels = i.labels.filter((n) => !v.r.includes(`L${n}`));
      return {};
    }
    if (q.startsWith("mutation(")) w.mutations = (w.mutations ?? 0) + 1;
    if (q.startsWith("mutation(") && q.includes("w0:")) {
      for (const [, k, name] of q.matchAll(/w(\d+):(\w+)\(/g)) WRITE[name](v[`v${k}`]);
      return {};
    }
    if (q.includes("removeSubIssue")) {
      w.at(Number(v.c.slice(1))).parent = null;
      w.writes.push(["親子を外す", Number(v.c.slice(1))]);
      return void WRITE.addComment({ subjectId: v.c, body: v.b });
    }
    if (q.includes("comments(first:100,after:$a)")) return { repository: { issue: { comments: { pageInfo: { hasNextPage: false }, nodes: w.at(v.n).comments.map((body) => ({ body })) } } } };
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
      return { repository: { labels: { nodes: repoLabels().map((name) => ({ id: `L${name}`, name })) }, issue: { id: `I${i.n}`, title: "タスク", url: `https://github.test/${i.n}`, body: i.body,
        bodyHTML: i.body, labels: names(i.labels),
        comments: { nodes: i.comments.map((body) => ({ body, bodyHTML: body, url: "https://github.test/c", createdAt: "2026-10-11T00:00:00Z", author: { login: "x" } })) } } } };
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
    w.requests++;
    let m;
    if (path.endsWith(`/workflows/${config.workflow}`)) return { state: workflow };
    if (path.includes("/runs?per_page=100")) return { workflow_runs: [...w.runs, ...last].reverse().map((r) => ({ id: r.id, display_title: r.display_title ?? "#99 実装",
      status: r.status ?? "completed", conclusion: r.conclusion ?? null, created_at: r.created_at ?? new Date().toISOString(), updated_at: r.updated_at ?? new Date().toISOString() })) };
    if (path.endsWith("/jobs")) return { jobs: [{ steps }] };
    if (path.endsWith("/dispatches")) { // 本物と同じく、振り出すと実行の申し込みの知らせが届く
      const r = { id: 100 + w.runs.length, display_title: `#${body.inputs.issue} ${body.inputs.kind} ${body.inputs.key}`, status: "queued" };
      w.runs.push(r);
      return void (await w.inbox.push(...ev.run(r, "requested")));
    }
    if ((m = /\/actions\/runs\/(\d+)\/cancel$/.exec(path))) {
      if (w.ended?.includes(Number(m[1]))) throw new Error(`GitHub POST ${path}: 409 {"message":"Cannot cancel a workflow run that is completed."}`);
      return void w.writes.push(["取り消し", Number(m[1])]);
    }
    if ((m = /\/commits\/(\w+)\/pulls$/.exec(path))) return [...w.issues.values()].filter((i) => i.pr?.sha === m[1]).map((i) => ({ head: { ref: `${config.branchPrefix}${i.n}` } }));
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
const ev = {
  // 実行の申し込み・始まり・終わりの知らせ。実行の status は知らせのとおりに進む（終わったあとに届いた始まりの知らせでは戻らない）。
  run: (r, action) => (r.status = r.status === "completed" || action === "completed" ? "completed" : action === "in_progress" ? "in_progress" : r.status ?? "queued", ["workflow_run", { action, sender: { login: config.gateBot }, repository: code, workflow_run: { id: r.id, path: `.github/workflows/${config.workflow}`, display_title: r.display_title } }]),
  ci: (branch, sha = "x") => ["workflow_run", { action: "completed", sender: { login: config.user }, repository: code, workflow_run: { id: 1, path: ".github/workflows/ci.yml", head_branch: branch, head_sha: sha } }],
  comment: (n, login = config.user) => ["issue_comment", { action: "created", sender: { login }, issue: { number: n }, repository: tasks }],
  issue: (n, action, login = config.user, more = {}) => ["issues", { action, sender: { login }, issue: { number: n, body: more.body }, changes: more.changes, repository: tasks }],
  pr: (n, action) => ["pull_request", { action, sender: { login: config.user }, repository: code, pull_request: { head: { ref: `${config.branchPrefix}${n}` } } }],
  move: (n) => ["issues", { action: "field_added", sender: { login: config.user }, issue: { number: n }, repository: tasks }],
  schedule: () => ["schedule", {}],
  sub: (p, c, action = "sub_issue_added") => ["sub_issues", { action, sender: { login: config.claude }, repository: tasks,
    parent_issue: { number: p, node_id: `I${p}` }, sub_issue: { number: c, node_id: `I${c}` } }],
};
const head = (i) => i.comments.at(-1)?.split("\n")[0] ?? null;
const QUESTION = SKELETON.判断; // 形どおりの判断の問い
const ANSWER = (line) => `## 回答\n**${QUESTION.split("\n")[1]}**\n\n${line}`;
const CONFIRM = "- [x] 作る\n- [ ] 見た目\n  - 確かめる: ユーザー\n";
const ASKED = (kind) => askText(kind, config.questionForms, [{ text: "見た目" }]); // ゲートが出す問い（確かめは CONFIRM のユーザーが確かめる条件を並べる）

// ゲートのコメントだけを見る（担当の終わりのコメントは担当のワークフローが書く）。
const said = (i) => i.comments.filter((c) => !/^### \S+担当の終わり/.test(c)).at(-1)?.split("\n")[0] ?? null;

test("R2・R17・R14・K1: 振り出したその場で実装（順番待ちを含む）。同時に届いた出来事でも、1つのタスクに担当は1人で、枠の数まで急ぎ・優先度の順。欄「実行の status」は実行の知らせのとおり", async () => {
  const w = world([{ n: 1, status: "実装", priority: "低" }, { n: 2, status: "実装", labels: [config.urgentLabel] }, { n: 3, status: "実装", priority: "高" },
    { n: 4, status: "実装", blockedBy: [9] }, { n: 5, status: "実装", start: "2099-01-01" }, { n: 9, status: "保留" }]);
  await Promise.all([w.push(ev.schedule()), w.push(ev.schedule()), w.push(ev.comment(1))]);
  await w.inbox.drain(config.retries);
  assert.deepEqual(w.titles().sort(), ["#2 実装", "#3 実装"]);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => w.at(n).status), ["実装", "実装", "実装", "待機", "待機", "保留"], "待つ相手のあるものは待機");
  assert.deepEqual([w.at(1).run, w.at(2).run], [null, "queued"], "実行が無ければ空、申し込んだ実行は queued");
  await w.send(ev.run(w.run(2), "in_progress"));
  assert.equal(w.at(2).run, "in_progress");
  await w.send(ev.run({ id: 7, display_title: "#2 実装" }, "completed"));
  assert.equal(w.at(2).status, "実装", "別の実行（手で起こした実行）の終わりで、今の担当を手放さない");
  w.at(3).comments.push(END(0));
  await w.send(ev.run(w.run(3), "completed"));
  await w.send(ev.run(w.run(3), "in_progress"));
  assert.deepEqual([w.at(3).status, said(w.at(3)), w.at(3).run], ["回答", "## 問い（イレギュラー）", null], "終わったあとに届いた始まりの知らせで持ち直さない");
});

test("R3・決め1・決め7・#760: 担当の実行が終わったら、表の上から最初に当たる行で決める。状態も約束も動かさずに終えた担当だけがイレギュラー", async () => {
  const verify = { status: "検証", pr: { draft: false, checks: "SUCCESS" } };
  const merged = { state: "MERGED", merged: true };
  const rows = [
    // [要求, 始まりのタスク, 終わったときの事実（moved はその実行で約束が動いたか）, ステータス, 起きた担当の数, 最後のゲートのコメントの頭]
    ["R3a 答えの無い問い", {}, { comments: [QUESTION] }, "回答", 1, "## 問い（判断）"],
    ["R3b 下書きの PR の検査が終わっていない", {}, { pr: { draft: true, checks: "PENDING" } }, "検査", 1, null],
    ["実装担当が、検査の出ない PR を出して手放した（検査の持ち主がいない）→ イレギュラー", {}, { pr: { draft: true } }, "回答", 1, "## 問い（イレギュラー）"],
    ["R3c 下書きでない PR の検査が通った → 検証 → 検証担当", {}, { pr: { draft: false, checks: "SUCCESS" } }, "検証", 2, null],
    ["R3d 検証担当が下書きへ戻した（差し戻し）→ 実装担当", verify, { pr: { draft: true, checks: "SUCCESS", drafted: true } }, "実装", 2, null],
    ["検証担当が、マージも差し戻しも問いもせずに手放した → イレギュラー", verify, {}, "回答", 1, "## 問い（イレギュラー）"],
    ["R3e 条件が全部済んだ → 完成で閉じる", {}, { body: "- [x] 作る\n" }, "完了", 1, null],
    ["R3f 残りがユーザーの確かめだけ", {}, { body: CONFIRM }, "回答", 1, "## 問い（確かめ）"],
    ["R3g 開いた前提", {}, { blockedBy: [9] }, "待機", 1, null],
    ["R3g 未来の着手可能日時", {}, { start: "2099-01-01" }, "待機", 1, null],
    ["R3h 状態も約束も動かさずに終えた（落ちた）→ 黙って振り出し直さない", {}, {}, "回答", 1, "## 問い（イレギュラー）"],
    ["#760 約束を兄弟へ移管して終えた（約束が動いた）→ 正当。残りを次の実装担当へ", { body: "- [ ] 作る\n- [ ] 部品\n" },
      { body: "- [ ] 作る\n", made: [{ n: 10, body: "分割元: #1\n- [ ] 部品\n", created: T(5) }] }, "実装", 2, null],
    ["移管先の無い行を消して終えた（約束をなくした）→ イレギュラー", { body: "- [ ] 作る\n- [ ] 部品\n" }, { body: "- [ ] 作る\n" }, "回答", 1, "## 問い（イレギュラー）"],
    ["条件にチェックを付けて終えた（約束が動いた）→ 正当。残りを次の実装担当へ", { body: "- [ ] 作る\n- [ ] 直す\n" }, { body: "- [x] 作る\n- [ ] 直す\n" }, "実装", 2, null],
    ["決め1 検証担当がマージし、本番に出たあとに残りがある → 実装担当", verify, { pr: { ...merged, mergeChecks: "SUCCESS" } }, "実装", 2, null],
    ["マージのコミットの検査がまだ（本番に出る前に確かめを問わない）", verify, { body: CONFIRM, pr: { ...merged, mergeChecks: "PENDING" } }, "検査", 1, null],
    ["マージのコミットの検査が1つも無い（合格していない）→ 実装担当", verify, { pr: merged }, "実装", 2, null],
    ["マージのコミットの検査が落ちた → 打ち直すか直す実装担当", verify, { body: CONFIRM, pr: { ...merged, mergeChecks: "FAILURE" } }, "実装", 2, null],
    ["マージのコミットの検査が取り消された（合格でない）→ 実装担当", verify, { body: CONFIRM, pr: { ...merged, mergeChecks: "CANCELLED" } }, "実装", 2, null],
    ["実装担当が、落ちたマージのコミットの検査を打ち直しも直しもせずに手放した → イレギュラー", { body: CONFIRM }, { pr: { ...merged, mergeChecks: "FAILURE" } }, "回答", 1, "## 問い（イレギュラー）"],
    ["検査の1つが落ちても、ほかが走っている間は終わっていない → 検査", verify, { body: CONFIRM, pr: { ...merged, mergeChecks: "FAILURE", mergeRunning: true } }, "検査", 1, null],
  ];
  for (const [name, start, { made = [], ...facts }, status, runs, comment] of rows) {
    const w = world([{ n: 1, status: "実装", ...start }, { n: 9, status: "保留" }]);
    await w.send(ev.schedule());
    const run = w.run(1);
    await w.send(ev.run(run, "requested"));
    const kind = start.status ?? "実装";
    assert.equal(w.at(1).status, kind, name);
    const before = w.at(1).body;
    Object.assign(w.at(1), facts);
    for (const i of made) w.issues.set(i.n, { state: "OPEN", comments: [], by: [], blockedBy: [], labels: [], assignees: [], ...i });
    w.at(1).comments.push(END(w.at(1).comments.length, kind, before));
    await w.send(ev.run(run, "completed"));
    assert.deepEqual([w.at(1).status, w.runs.length, said(w.at(1))], [status, runs, comment], name);
    if (status === "回答") assert.deepEqual([w.at(1).assignees, w.at(1).body.startsWith("<!-- flow-gate -->")], [[config.user], true], `${name}: ユーザーの番で、本文の頭に回答のボタン`);
    if (status === "検査") assert.equal(w.at(1).run, "in_progress", `${name}: 欄「実行の status」は、終わりから最も遠い検査の実行の status`);
  }
});

test("出来事1つで決め直す（R2・R4〜R9・R16・K2・K5・決め5・決め7・開発機で作業中・Claude の本文の書き換え）", async () => {
  const merged = { state: "MERGED", merged: true, mergeChecks: "SUCCESS", sha: "m1" };
  const rows = [
    // [要求, タスク, 担当が付いた後に変わる事実（無ければ担当なし）, 出来事, 期待]
    ["R4 PR の検査が落ちた → 同じ枝で直す実装担当", { status: "検査", pr: { draft: true, checks: "FAILURE" } }, null, ev.ci(`${config.branchPrefix}1`), { status: "実装", runs: ["#1 実装"] }],
    ["R4 PR の検査が通った → PR をレビュー可能にして検証担当", { status: "検査", pr: { draft: true, checks: "SUCCESS" } }, null, ev.ci(`${config.branchPrefix}1`), { status: "検証", draft: false, runs: ["#1 検証"] }],
    ["原則の点検の1 マージのコミットの検査が落ちた → 本番に出ていないので確かめを問わず、打ち直すか直す実装担当", { status: "検査", body: CONFIRM, pr: { ...merged, mergeChecks: "FAILURE" } }, null,
      ev.ci(config.base, "m1"), { status: "実装", comment: null, runs: ["#1 実装"] }],
    ["親が保留の子のマージのコミットの検査が落ちた → 待機（振り出さない）", { status: "検査", parent: 4, body: "- [ ] 部品\n", pr: { ...merged, mergeChecks: "FAILURE" } }, null, ev.ci(config.base, "m1"), { status: "待機", runs: [] }],
    ["K2・R12 確かめの答えが完了にせず文だけ → 閉じず、Claude の番（実装担当が読む）", { status: "回答", body: CONFIRM, comments: [ASKED("確かめ"), "## 回答\n**完成にしてよいですか？**\n\n見た目が崩れる"] }, null, ev.comment(1),
      { state: "OPEN", status: "実装", runs: ["#1 実装"] }],
    ["決め6 前からある Claude の割り当ては外し、保留ではユーザーだけ", { status: "保留", assignees: [config.claude] }, null, ev.comment(1), { assignees: [config.user] }],
    ["R6 見送り（Close as not planned）で閉じたものは閉じたまま", { status: "完了", state: "CLOSED", reason: "NOT_PLANNED" }, null, ev.issue(1, "closed"), { state: "CLOSED" }],
    ["A 対話作業は、検査・検証を開発機のセッションの中で済ませ、ラベル「開発機で作業中」が無い間はユーザーの番", { status: "実装", type: config.dialogType, pr: { draft: true, checks: "PENDING" } }, null,
      ev.comment(1), { status: "実装", assignees: [config.user], runs: [] }],
    ["開発機のセッションが触っている間（ラベル「開発機で作業中」）は振り出さず、担当者は Claude", { status: "実装", labels: [config.devLabel] }, null, ev.comment(1),
      { status: "実装", assignees: [config.claude], runs: [] }],
    ["開発機のセッションが触っている対話作業は、担当者が Claude", { status: "実装", type: config.dialogType, labels: [config.devLabel] }, null, ev.comment(1), { assignees: [config.claude] }],
    ["R8 マージのコミットの検査が通った → 確かめの問い", { status: "検査", body: CONFIRM, pr: merged }, null, ev.ci(config.base, "m1"), { status: "回答", comment: "## 問い（確かめ）" }],
    ["R8・決め7 検査が通ったあとに PR が下書きへ戻された（差し戻し）→ 実装担当", { status: "検証", pr: { draft: true, checks: "SUCCESS", drafted: true } }, null, ev.pr(1, "converted_to_draft"),
      { status: "実装", runs: ["#1 実装"] }],
    ["R5・決め1・決め6 判断の答えで続ける → 表で決め直して実装担当（ユーザーの番を出たら Claude の番）", { status: "回答", assignees: [config.user], comments: [QUESTION, ANSWER("補足: A で")] }, null,
      ev.comment(1), { status: "実装", runs: ["#1 実装"], assignees: [config.claude] }],
    ["R5・決め6 答えが保留 → 保留（ユーザーの番）", { status: "回答", comments: [QUESTION, ANSWER("回答: 保留する")] }, null, ev.comment(1), { status: "保留", assignees: [config.user] }],
    ["R6・決め5 ユーザーが保留から出す → 表で決め直す", { status: "実装" }, null, ev.move(1), { status: "実装", runs: ["#1 実装"] }],
    ["R6 条件が全部済んでユーザーが完了へ動かす → 受ける（完成）", { status: "完了", body: "- [x] 作る\n" }, null, ev.move(1), { status: "完了", state: "CLOSED", reason: "COMPLETED" }],
    ["K2 条件が残ったまま完成で閉じた → 開き直す", { status: "保留", state: "CLOSED", reason: "COMPLETED" }, null, ev.issue(1, "closed"), { state: "OPEN" }],
    ["R7 担当が持っているタスクをユーザーが保留へ → その実行を取り消す", { status: "実装" }, { status: "保留" }, ev.move(1), { status: "保留", cancels: [100], assignees: [config.user] }],
    ["R2・R13・K4 担当が付いている間は決め直さず、その間に出した問いのボタンも消さない", { status: "実装" }, { comments: [QUESTION], body: withButton("- [ ] 作る\n", config, 1) }, ev.comment(1),
      { status: "実装", runs: ["#1 実装"], button: true }],
    ["R9・R13 Claude が起こした要望は採否を問い、本文の頭のボタンは問いより先に書く", { author: config.claude, type: "要望" }, null, ev.issue(1, "opened", config.claude),
      { status: "回答", comment: "## 問い（採否）", writes: ["本文", "コメント"] }],
    ["R16 対話作業は振り出さない", { type: config.dialogType }, null, ev.issue(1, "opened"), { status: "実装", runs: [] }],
    ["R16 対話作業の境目をまたがない種類の変更は通す", { status: "保留", type: "要望", typeChanges: [["不具合", "要望"]] }, null, ev.issue(1, "typed"), { type: "要望" }],
    ["R16 対話作業の境目をまたぐ種類の変更は戻す", { status: "実装", type: "不具合", typeChanges: [[config.dialogType, "不具合"]] }, null, ev.issue(1, "typed"), { type: config.dialogType }],
    ["Claude が本文の完了の条件にチェックを付けた → 決め直す", { status: "実装", body: "- [x] 作る\n" }, null, ev.issue(1, "edited", config.claude), { status: "完了" }],
    ["条件の無い issue は、約束が全部果たされた（無い）ので完成で閉じる", { status: "実装", body: "説明だけ\n" }, null, ev.comment(1), { state: "CLOSED", reason: "COMPLETED" }],
  ];
  for (const [name, task, change, event, want] of rows) {
    const w = world([{ n: 1, ...task }, { n: 4, status: "保留", priority: "高" }]);
    if (change) await w.send(ev.schedule()).then(() => w.send(ev.run(w.run(1), "requested")));
    Object.assign(w.at(1), change);
    await w.send(event);
    const i = w.at(1);
    const got = { status: i.status, state: i.state, reason: i.reason, type: i.type, priority: i.priority, assignees: i.assignees, comment: head(i), runs: w.titles(),
      draft: i.pr?.draft, button: i.body.startsWith("<!-- flow-gate -->"),
      cancels: w.writes.filter(([k]) => k === "取り消し").map(([, id]) => id), writes: w.writes.filter(([, n]) => n === 1).map(([k]) => k) };
    assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, got[k]])), want, name);
  }
});

test("答えは、そのあとにユーザーがステータスを変えたか開き直したら当て直さない（ゲートは自分の書いた値でなく、時系列の事実で決める）", async () => {
  const w = world([{ n: 1, status: "回答", comments: [QUESTION, ANSWER("回答: 保留する")] },
    { n: 2, status: "回答", author: config.claude, type: "要望", comments: [ASKED("採否"), "## 回答\n**このタスクに着手しますか？**\n\n回答: 見送る"] }]);
  await w.send(ev.comment(1));
  assert.equal(w.at(1).status, "保留", "答えの保留を当てる");
  Object.assign(w.at(1), { status: "実装", moves: [[config.user, 1, config.fields.status.name]] });
  await w.send(ev.move(1));
  assert.deepEqual([w.at(1).status, w.titles()], ["実装", ["#1 実装"]], "ユーザーが保留から出したら、古い答えで保留へ戻さない");
  await w.send(ev.comment(2));
  assert.deepEqual([w.at(2).state, w.at(2).reason], ["CLOSED", "NOT_PLANNED"], "答えの見送りを当てる");
  Object.assign(w.at(2), { state: "OPEN", reason: null, moves: [[config.user, 1]] });
  await w.send(ev.issue(2, "reopened"));
  assert.deepEqual([w.at(2).state, w.at(2).status], ["OPEN", "実装"], "ユーザーが開き直したら、古い答えで閉じ直さない");
  Object.assign(w.at(1), { status: "保留", moves: [[config.claude, 1, config.fields.status.name]] });
  await w.send(ev.move(1));
  assert.equal(w.at(1).status, "保留", "ユーザーでない者の変更は、答えを置き換えない");
});

test("1件の決め直しの書き込みは、GitHub への書き込みの要求1回にまとめる（本文・欄・ラベル・コメント・閉じる）", async () => {
  // 回数そのものが GitHub の利用の上限と費用に効くので、書き込みの要求の数を確かめる。
  const w = world([{ n: 1, author: config.claude, type: "要望", labels: [config.urgentLabel] }, { n: 2, status: "回答", body: "- [x] 作る\n", labels: ["問い: 判断"], comments: [QUESTION] }]);
  let before = w.mutations ?? 0;
  await w.send(ev.issue(1, "opened", config.claude));
  assert.deepEqual([w.at(1).status, w.at(1).labels.sort(), head(w.at(1))], ["回答", ["問い: 採否", config.urgentLabel].sort(), "## 問い（採否）"]);
  assert.equal(w.mutations - before, 1, "本文のボタン・ステータス・担当者・ラベル・問いのコメントを1回で書く");
  before = w.mutations;
  await w.send(ev.comment(2, config.claude));
  assert.deepEqual([w.at(2).state, w.at(2).labels, w.mutations - before], ["CLOSED", [], 1], "ラベルを外して閉じるのも1回");
});

test("tasks#868 答えの無い問いが残っていても、完了の条件が全部済めば完成で閉じ、ボタンを外す。採否だけは答えを待つ", async () => {
  const merged = { state: "MERGED", merged: true, mergeChecks: "SUCCESS", sha: "m1" };
  const rows = [
    // [要求, タスク, 出来事, 期待するステータス]
    ["#865 イレギュラーを問うたあと、別の所で作って条件が全部済んだ", { body: withButton("- [x] 作る\n", config, 1), comments: [ASKED("イレギュラー")] }, ev.comment(1, config.claude), "完了"],
    ["判断を問うたあとで条件が全部済んだ", { body: withButton("- [x] 作る\n", config, 1), comments: [QUESTION] }, ev.comment(1, config.claude), "完了"],
    ["確かめを問うたあとでユーザーの確かめの行にもチェックが付いた", { body: withButton("- [x] 作る\n- [x] 見た目\n  - 確かめる: ユーザー\n", config, 1), comments: [ASKED("確かめ")] },
      ev.issue(1, "edited"), "完了"],
    ["問いのあとで、子の PR がマージされ、マージのコミットの検査が通り、子の条件が全部済んだ", { parent: 2, body: withButton("- [x] 部品\n", config, 1), comments: [ASKED("イレギュラー")], pr: merged },
      ev.ci(config.base, "m1"), "完了"],
    ["採否は、着手するかの答えが要るので待つ", { author: config.claude, type: "要望", body: withButton("説明だけ\n", config, 1), comments: [ASKED("採否")] }, ev.comment(1, config.claude), "回答"],
  ];
  for (const [name, task, event, status] of rows) {
    const w = world([{ n: 1, status: "回答", assignees: [config.user], ...task }, { n: 2, status: "待機", body: "- [ ] a\n  - 確かめる: ユーザー\n" }]);
    await w.send(event);
    const i = w.at(1);
    const done = status === "完了";
    assert.deepEqual([i.status, i.state, i.reason, i.body.startsWith("<!-- flow-gate -->"), i.assignees], [status, done ? "CLOSED" : "OPEN", done ? "COMPLETED" : null, !done, done ? [] : [config.user]], name);
  }
});

test("tasks#877 問いを出した事実が無くなったら、条件が残っていても回答に留めず表で決め直し、ボタンを外す。事実が残る問いと Claude の判断の問いは待つ", async () => {
  const left = "- [x] 作る\n- [ ] 見た目\n  - 確かめる: ユーザー\n- [ ] 直す\n";
  const rows = [
    // [要求, タスク, 出来事, 期待するステータス]
    ["見送りの前提について問うたあとで、前提が開き直された", { blockedBy: [7], comments: [askDropped([7], config.questionForms)] }, ev.issue(7, "reopened"), "待機"],
    ["イレギュラーを問うたあとで、作業ブランチの PR が開かれた", { comments: [ASKED("イレギュラー")], pr: { created: T(1), checks: "PENDING" } }, ev.pr(1, "opened"), "検査"],
    ["イレギュラーを問うたあとで、問う前からあった PR がマージされた", { comments: [ASKED("イレギュラー")], pr: { state: "MERGED", merged: true, mergeChecks: "SUCCESS", sha: "m1", mergedAt: T(1) } },
      ev.ci(config.base, "m1"), "実装"],
    ["確かめを問うたあとで、Claude が確かめる条件が足された", { body: withButton(left, config, 1), comments: [ASKED("確かめ")] }, ev.issue(1, "edited", config.claude), "実装"],
    ["見送りの前提がまだ見送りのままなら待つ", { blockedBy: [8], comments: [askDropped([8], config.questionForms)] }, ev.comment(1, config.claude), "回答"],
    ["検証担当が手放したイレギュラーは、問う前からある開いた PR では片付かない", { comments: [ASKED("イレギュラー")], pr: { checks: "SUCCESS" } }, ev.pr(1, "synchronize"), "回答"],
    ["Claude の判断の問いは、ゲートが中身を読まないので待つ", { comments: [QUESTION] }, ev.comment(1, config.claude), "回答"],
  ];
  for (const [name, task, event, status] of rows) {
    const w = world([{ n: 1, status: "回答", assignees: [config.user], body: withButton("- [ ] 作る\n", config, 1), ...task }, { n: 7, status: "実装" },
      { n: 8, status: "完了", state: "CLOSED", reason: "NOT_PLANNED" }], { workflow: "disabled" });
    await w.send(event);
    const i = w.at(1);
    const asking = status === "回答";
    assert.deepEqual([i.status, i.state, i.body.startsWith("<!-- flow-gate -->"), i.assignees, asked(i)], [status, "OPEN", asking, asking ? [config.user] : [config.claude], 1], name);
  }
});

test("tasks#842・#843 担当者を手で変えたら決め直して戻す。1つのタスクを触るのは1者だけ", async () => {
  // 担当者を手で変えたら、その出来事で決め直し、ゲートの決めた値へ戻す。
  const hand = world([{ n: 1, status: "回答", comments: [QUESTION], assignees: [config.user, config.claude] }]);
  await hand.send(ev.issue(1, "assigned"));
  assert.deepEqual(hand.at(1).assignees, [config.user], "回答の担当者はユーザーだけ");
  // 1つのタスクを触るのは1者だけ: 同じ issue の実行が2本あれば、いちばん古いものを残してほかを取り消す。
  const two = world([{ n: 1, status: "実装" }]);
  two.runs.push({ id: 7, display_title: "#1 実装 a", status: "in_progress", created_at: "2026-10-11T00:00:00Z" },
    { id: 8, display_title: "#1 実装 b", status: "queued", created_at: "2026-10-11T00:00:05Z" });
  await two.send(ev.run(two.runs[1], "requested"));
  assert.deepEqual([two.at(1).status, two.writes.filter(([k]) => k === "取り消し").map(([, id]) => id)], ["実装", [8]]);
  // もう終わった実行の取り消しは GitHub が断る（409）が、取り消しは済んでいるので、出来事の処理を落とさない。
  const gone = world([{ n: 1, status: "実装" }]);
  gone.ended = [8];
  gone.runs.push(...two.runs.map((r) => ({ ...r })));
  await assert.doesNotReject(handle(gone.gh, { inbox: gone.inbox }, config, ...ev.run(gone.runs[1], "requested")), "409 で出来事の処理を落とさない");
  assert.equal(gone.at(1).status, "実装");
});

test("検査の出ない PR は合格していないので実装。実装担当がそのまま手放したらイレギュラーで、「やり直す」と答えたら実装担当へ渡す", async () => {
  // 実装担当が、検査の出ない PR を出して手放した（実装のまま）→ イレギュラー → 「やり直す」と答える。
  const handOff = async (w) => {
    await w.send(ev.schedule());
    const run = w.run(1);
    await w.send(ev.run(run, "requested"));
    w.at(1).pr = { draft: true };
    w.at(1).comments.push(END(0));
    await w.send(ev.run(run, "completed"));
    assert.equal(head(w.at(1)), "## 問い（イレギュラー）");
    w.at(1).comments.push(answerBody(latestQuestion(w.at(1).comments, config.questionForms), { choice: "やり直す" }));
  };
  const w = world([{ n: 1, status: "実装" }]);
  await handOff(w);
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).status, w.titles(), w.at(1).assignees], ["実装", ["#1 実装", "#1 実装"], [config.claude]], "実装担当へ渡す");
  // 枠が埋まっていてすぐ振り出せなくても、答えのあとに担当が終わるまで「やり直す」を保つ。
  const full = world([{ n: 1, status: "実装" }, { n: 2, status: "実装" }, { n: 3, status: "実装" }]);
  await handOff(full);
  assert.deepEqual(full.titles().filter((t) => t !== "#1 実装"), ["#2 実装", "#3 実装"], "実装の枠（2）が埋まる");
  await full.send(ev.comment(1));
  await full.send(ev.comment(1));
  assert.equal(full.at(1).status, "実装", "次の決め直しでも検査へ戻さない");
  await full.send(ev.run(full.run(2), "completed"));
  assert.deepEqual([full.at(1).status, full.titles().filter((t) => t === "#1 実装").length], ["実装", 2], "枠が空いたら実装担当へ渡す");
  // 答えのあとに担当が終わっていれば（終わりのコメントが issue に残る）、「やり直す」は効き終わっている。
  const ended = world([{ n: 1, status: "回答", pr: { draft: true, checks: "PENDING" }, comments: [...w.at(1).comments, END(w.at(1).comments.length + 1)] }]);
  await ended.send(ev.comment(1, config.claude));
  assert.equal(ended.at(1).status, "検査", "担当が終わったあとの検査は検査");
});

test("前提が閉じたら、後ろで待っていたタスクも決め直して振り出す（閉じた issue の先は、決め直しで読んだ事実から取る）", async () => {
  const w = world([{ n: 6, status: "待機", blockedBy: [7] }, { n: 7, status: "回答", state: "CLOSED" }]);
  await w.send(ev.issue(7, "closed"));
  assert.deepEqual([w.at(6).status, w.titles()], ["実装", ["#6 実装"]]);
});

// 分けたタスクの扱い（tasks#824・#842 の C4）: 子は要望の値（優先度・日時・急ぎ・保留・採否）を親から継ぎ、約束（完了の条件）は自分の本文に持つ。
// 待つ相手は前提と子で、閉じたことと保留が矢印1本ずつ伝わる。
const asked = (i) => i.comments.filter((c) => c.startsWith("## 問い")).length;
const ACCEPT = "- [ ] 動く\n  - 確かめる: ユーザー\n"; // 親（要望）の約束: ユーザーが確かめる要望の結果
const PART = "- [ ] 部品\n"; // 子（機能）の約束

test("C4 待つ相手: 開いた子がある親は待機し、確かめを問わない。子が全部閉じたら親の確かめを一度だけ問う（子の約束は子の本文にあり、親の行にチェックを付けない）", async () => {
  const w = world([{ n: 1, status: "実装", body: ACCEPT }, { n: 2, parent: 1, status: "実装", body: PART }]);
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).status, asked(w.at(1))], ["待機", 0], "#633: 子が開いている間は、親の確かめを問わない");
  Object.assign(w.at(2), { state: "CLOSED", reason: "COMPLETED", body: "- [x] 部品\n" });
  await w.send(ev.issue(2, "closed"));
  assert.deepEqual([w.at(1).body.includes("- [ ] 動く"), w.at(1).status, head(w.at(1)), asked(w.at(1))], [true, "回答", "## 問い（確かめ）", 1]);
  await w.send(ev.comment(1));
  assert.equal(asked(w.at(1)), 1, "確かめは一度だけ");
  w.at(1).comments.push("## 回答\n**完成にしてよいですか？**\n\n回答: 完了にする\n- 確かめた: 動く");
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).state, w.at(1).reason], ["CLOSED", "COMPLETED"]);
});

test("tasks#824 継承: 子は優先度・着手可能日時・急ぎ・保留を親の値で見る。子は自分の約束が全部果たされ、マージのコミットの検査が通ったら閉じ、親へ伝わる", async () => {
  // 子の欄が空のままなら既定の「中」で並び、番号の小さい #3 が先になる。親の値を見ると、高い親の子 #8 が先になる。
  const w = world([{ n: 1, status: "実装", priority: "高", body: ACCEPT }, { n: 8, parent: 1, body: PART }, { n: 3, status: "実装", priority: "中" },
    { n: 4, status: "実装", priority: "低", body: ACCEPT }, { n: 5, parent: 4, status: "実装", body: PART }]);
  await w.send(ev.issue(8, "opened"));
  assert.deepEqual([w.at(8).state, w.at(8).priority], ["OPEN", null], "作ったとたんに閉じず、優先度の欄は空のまま");
  assert.deepEqual(w.titles().sort(), ["#3 実装", "#8 実装"], "高い親の子を、低い親の子より先に振り出す（親は子を待つ）");
  Object.assign(w.at(8), { body: "- [x] 部品\n", pr: { state: "MERGED", merged: true, mergeChecks: "SUCCESS", sha: "m8" } });
  w.at(8).comments.push(END(0));
  await w.send(ev.run(w.run(8), "completed"));
  assert.deepEqual([w.at(8).state, w.at(8).reason], ["CLOSED", "COMPLETED"]);
  assert.deepEqual([w.at(1).status, head(w.at(1))], ["回答", "## 問い（確かめ）"], "子が閉じたら、同じ出来事の中で親を決め直す");

  const v = world([{ n: 1, status: "保留", body: ACCEPT }, { n: 2, parent: 1, status: "実装", body: PART },
    { n: 3, status: "実装", start: "2099-01-01", body: ACCEPT }, { n: 4, parent: 3, status: "実装", body: PART },
    { n: 5, status: "実装", priority: "低", labels: [config.urgentLabel], body: ACCEPT }, { n: 6, parent: 5, status: "実装", body: PART },
    { n: 7, status: "実装", priority: "高" }]);
  await v.send(ev.schedule());
  assert.deepEqual(v.titles().sort(), ["#6 実装", "#7 実装"], "保留の親の子・日時が先の親の子は振り出さず、急ぎの親の子を先に並べる");
  assert.deepEqual([v.at(2).status, v.at(4).status], ["待機", "待機"], "保留の親の子・日時が先の親の子は待機");
});

test("tasks#824 親が閉じたら: 開き直されない閉じ方なら、開いている子を見送りで閉じて知らせる（動いている実行も取り消す）", async () => {
  const w = world([{ n: 1, status: "実装", body: ACCEPT }, { n: 2, parent: 1, status: "実装", body: PART }, { n: 3, status: "実装", blockedBy: [2] }]);
  await w.send(ev.schedule());
  await w.send(ev.run(w.run(2), "requested"));
  Object.assign(w.at(1), { state: "CLOSED", reason: "COMPLETED", body: "- [x] 動く\n  - 確かめる: ユーザー\n" }); // ユーザーが「満たされた」と閉じた
  await w.send(ev.issue(1, "closed"));
  assert.deepEqual([w.at(2).state, w.at(2).reason, head(w.at(2)), w.writes.filter(([k]) => k === "取り消し").map(([, id]) => id)],
    ["CLOSED", "NOT_PLANNED", "親 #1 が閉じたので、見送りで閉じます。", [w.run(2).id]]);
  assert.deepEqual([w.at(3).status, head(w.at(3))], ["回答", "## 問い（判断）"], "ゲートが閉じた子の先（その子を待つ issue）まで、同じ出来事の中で決め直す");
  for (const [name, parent, want] of [["条件の残る親を完成で閉じた → 親は開き直し、子はそのまま", { reason: "COMPLETED" }, ["OPEN", "OPEN"]],
    ["親を見送りで閉じた → 子も見送り", { reason: "NOT_PLANNED" }, ["CLOSED", "CLOSED"]]]) {
    const x = world([{ n: 1, status: "実装", state: "CLOSED", body: ACCEPT, ...parent }, { n: 2, parent: 1, status: "保留", body: PART }]);
    await x.send(ev.issue(1, "closed"));
    assert.deepEqual([x.at(1).state, x.at(2).state], want, name);
  }
});

test("tasks#824 待つ相手が見送りで閉じたら、続けるかを一度だけ問う（前提でも子でも同じ）", async () => {
  const w = world([{ n: 6, status: "待機", blockedBy: [7] }, { n: 7, status: "完了", state: "CLOSED", reason: "NOT_PLANNED" }]);
  await w.send(ev.issue(7, "closed"));
  assert.deepEqual([w.at(6).status, head(w.at(6)), w.at(6).comments.at(-1).includes(droppedQuestion([7]))], ["回答", "## 問い（判断）", true]);
  w.at(6).comments.push(`## 回答\n**${droppedQuestion([7])}**\n\n回答: 続ける`);
  await w.send(ev.comment(6));
  assert.deepEqual([w.at(6).status, w.titles(), asked(w.at(6))], ["実装", ["#6 実装"], 1], "続けると決めたら問い直さない");
  const x = world([{ n: 1, status: "待機", body: ACCEPT }, { n: 2, parent: 1, status: "完了", state: "CLOSED", reason: "NOT_PLANNED", body: PART }]);
  await x.send(ev.issue(2, "closed"));
  assert.deepEqual([x.at(1).status, head(x.at(1))], ["回答", "## 問い（判断）"], "子が見送りなら、親で問う");
});

test("tasks#824 採否は親か分割元から受け継ぎ、一度だけ問う。孫は張られた直後に外す", async () => {
  const w = world([{ n: 1, status: "実装" }, { n: 2, author: config.claude, type: "要望", parent: 1, body: PART },
    { n: 3, author: config.claude, type: "要望", body: `${originLine(1)}\n- [ ] 作る\n` }, { n: 4, author: config.claude, type: "要望" }]);
  for (const n of [2, 3, 4]) await w.send(ev.issue(n, "opened", config.claude));
  assert.deepEqual([2, 3, 4].map((n) => asked(w.at(n))), [0, 0, 1], "採否を問うのは、親も分割元も持たない新しい要望だけ");
  w.at(4).comments.push("## 回答\n**このタスクに着手しますか？**\n\n回答: 着手する", QUESTION);
  await w.send(ev.comment(4, config.claude));
  assert.equal(w.at(4).comments.filter((c) => c.startsWith("## 問い（採否）")).length, 1, "採否を問うたことがあれば、ほかの問いのあとでも問い直さない");

  for (const [name, list, [p, c], want] of [
    ["親に親がある", [{ n: 1 }, { n: 2, parent: 1 }, { n: 3, parent: 2 }], [2, 3], null],
    ["子が子を持つ", [{ n: 5 }, { n: 6, parent: 5 }, { n: 7, parent: 6 }], [5, 6], null],
    ["正しい親子は外さず、親は子を待つ", [{ n: 1, status: "実装" }, { n: 2, parent: 1, status: "保留", body: PART }], [1, 2], 1]]) {
    const g = world(list);
    await g.send(ev.sub(p, c));
    assert.equal(g.at(c).parent, want, name);
    if (!want) assert.ok(g.at(c).comments.at(-1).endsWith(NO_GRANDCHILD), name);
    else assert.equal(g.at(p).status, "待機", name);
  }
});

test("tasks#824 レビューの直し: 重複も見送り側・古い問いもさかのぼる・閉じた親の子は振り出さない・見送りで閉じたら PR も閉じる", async () => {
  const dup = world([{ n: 1, status: "待機", body: ACCEPT }, { n: 2, parent: 1, status: "完了", state: "CLOSED", reason: "DUPLICATE", body: PART }]);
  await dup.send(ev.issue(2, "closed"));
  assert.deepEqual([dup.at(1).status, head(dup.at(1))], ["回答", "## 問い（判断）"], "重複で閉じた子も、続けるかを問う");

  const old = world([{ n: 6, status: "待機", blockedBy: [7], comments: [askDropped([7], config.questionForms), `## 回答\n**${droppedQuestion([7])}**\n\n回答: 続ける`,
    ...Array.from({ length: 45 }, (_, k) => `メモ ${k}`)] }, { n: 7, status: "完了", state: "CLOSED", reason: "NOT_PLANNED" }]);
  await old.send(ev.comment(6));
  assert.deepEqual([asked(old.at(6)), old.titles()], [1, ["#6 実装"]], "最近の40件より前に答えた問いも見つけ、問い直さない");

  const gone = world([{ n: 1, status: "完了", state: "CLOSED", reason: "COMPLETED", body: "- [x] a\n" }, { n: 2, parent: 1, status: "実装", body: PART }]);
  await gone.send(ev.schedule());
  assert.deepEqual(gone.titles(), [], "親が閉じた子は、決め直す前でも振り出さない");

  const pr = world([{ n: 1, status: "完了", state: "CLOSED", reason: "NOT_PLANNED" }, { n: 2, parent: 1, status: "検証", body: PART, pr: { draft: false, checks: "SUCCESS" } }]);
  await pr.send(ev.issue(1, "closed"));
  assert.deepEqual([pr.at(2).state, pr.at(2).reason, pr.at(2).pr.state], ["CLOSED", "NOT_PLANNED", "CLOSED"], "見送りで閉じた子の開いた PR も閉じる");
});

test("tasks#824 親子を外したら親は待ちをやめ、子を開き直したら親はまた待つ", async () => {
  const w = world([{ n: 1, status: "待機", body: "- [ ] a\n" }, { n: 2, status: "保留", body: PART }]);
  await w.send(ev.sub(1, 2, "sub_issue_removed"));
  assert.deepEqual(w.titles(), ["#1 実装"], "外された子を待たない");
  const x = world([{ n: 1, status: "回答", body: ACCEPT }, { n: 2, parent: 1, status: "完了", body: PART }]);
  await x.send(ev.issue(2, "reopened"));
  assert.deepEqual([x.at(1).status, asked(x.at(1)), x.titles()], ["待機", 0, ["#2 実装"]], "開き直した子を待ち、親の確かめを問わない");
});

test("tasks#824・#878・C4 記法: 条件はチェックの行から字下げした続きまで。「- 確かめる:」「- 見る所と要点:」だけが属性で、文の中の括弧や小項目は文の続き", () => {
  assert.deepEqual(conditions("- [ ] 道を押すと値が出る（区間の境目を含む）\n  境目では両側の値\n  - 夜間も含む\n- [x] 済んだ\n- [ ] 見た目（色）\n\n  - 確かめる: ユーザー\n  - 見る所と要点: [画面](https://github.test/c) の帯の色\n説明の段落\n"), [
    { index: 0, text: "道を押すと値が出る（区間の境目を含む） 境目では両側の値 - 夜間も含む", done: false, verify: "Claude", look: null },
    { index: 3, text: "済んだ", done: true, verify: "Claude", look: null },
    { index: 4, text: "見た目（色）", done: false, verify: "ユーザー", look: "[画面](https://github.test/c) の帯の色" }], "続きの間の空行のあとの属性も、同じ条件の属性");
});

test("tasks#878 確かめの問いの判断材料に、ユーザーが確かめる条件ごとの文と見る所と要点が並び、書かれていない条件はそう出る。答えは条件の文で当たる", async () => {
  const look = "[撮った画面](https://github.test/c) で、値の欄に区間の値が出ている";
  const w = world([{ n: 1, status: "検査", body: `- [x] 作る\n- [ ] 道を押すと値が出る\n  - 確かめる: ユーザー\n  - 見る所と要点: ${look}\n- [ ] 見た目\n  - 確かめる: ユーザー\n`,
    pr: { state: "MERGED", merged: true, mergeChecks: "SUCCESS", sha: "m1" } }]);
  await w.send(ev.ci(config.base, "m1"));
  const asked = w.at(1).comments.at(-1);
  assert.deepEqual([w.at(1).status, head(w.at(1))], ["回答", "## 問い（確かめ）"], "判断材料に条件を並べても、問いの形に合う");
  assert.ok(asked.includes(`- 道を押すと値が出る\n  - 見る所と要点: ${look}`), asked);
  assert.ok(asked.includes("- 見た目\n  - 見る所と要点: 書かれていません"), asked);
  w.at(1).comments.push(answerBody(latestQuestion(w.at(1).comments, config.questionForms), { done: true }));
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).state, w.at(1).reason], ["CLOSED", "COMPLETED"]);
});

test("K6・受け箱: 止めたら振り出さない。処理が落ちても出来事を失わず、一時の失敗はやり直し、直らない失敗はすぐ諦める", async () => {
  for (const [name, stop] of [["担当のワークフローが無効", { workflow: "disabled_manually" }], ["利用の上限で止まった直後",
    { last: [{ id: 5, status: "completed", conclusion: "failure", updated_at: new Date().toISOString() }], steps: [{ name: config.quotaStep, conclusion: "failure" }] }]]) {
    const off = world([{ n: 1, status: "実装" }], stop);
    await off.send(ev.schedule());
    assert.deepEqual(off.titles(), [], name);
  }
  const w = world([{ n: 1, status: "実装", body: "- [x] 作る\n" }, { n: 2, status: "実装", body: "- [x] 作る\n" }]);
  w.fail = Object.assign(new Error("GitHub が 502"), { transient: true });
  assert.ok((await w.send(ev.comment(1))) > Date.now(), "一時の失敗は、間をあけて起こす時刻を返す");
  w.fail = null;
  assert.ok((await w.send(ev.comment(2))) > Date.now(), "やり直しを待つ出来事がある間は、その時刻を返す");
  assert.deepEqual([w.at(1).status, w.at(2).status], ["実装", "完了"], "待っている出来事があっても、後ろの出来事は先に進む");
  assert.equal(await w.inbox.drain(config.retries, Date.now() + 3600e3), null);
  assert.equal(w.at(1).status, "完了", "やり直しで処理した");
  w.fail = new Error("GitHub が 404");
  assert.equal(await w.send(ev.comment(1)), null, "やり直しても直らない失敗は、すぐ諦める");
  w.fail = null;
  // 1回の起こしで処理する数を限ったら、残りがあれば今の時刻を返し、アラームを置き直す（置かれたアラームが無いときも置く）。
  const many = world([{ n: 1, status: "実装" }, { n: 2, status: "実装" }]);
  await many.push(ev.comment(1));
  await many.push(ev.comment(2));
  const now = Date.now();
  assert.equal(await many.inbox.drain(config.retries, now, 1), now);
  assert.equal((await many.inbox.pending("issue_comment")).length, 1, "限った数のあとの出来事は残る");
  for (const [next, set, want] of [[now, null, now], [now, now + 1, now], [now + 1, now, null], [null, null, null]]) assert.equal(nextAlarm(next, set), want, `${next} ${set}`);
});

test("tasks#307・K3・G4・G7: 本文の印の間・形に合わない問い・ボードの移動・着手可能日時の形", async () => {
  const w = world([{ n: 1, status: "実装", body: "<!-- flow-gate -->\nメモ\n<!-- /flow-gate -->\n\n- [ ] 作る\n" },
    { n: 2, status: "回答", comments: ["## 問い（判断）\n形に合わない"] }, { n: 3, status: "実装", start: "来週" }]);
  await w.send(ev.issue(1, "edited"));
  assert.deepEqual([w.at(1).body.startsWith("メモ\n"), w.at(1).comments.length], [true, 1], "G3 印の間の見知らぬ行は、消さずに印の外の先頭へ出してコメントで知らせる");
  await w.send(ev.comment(2, config.claude));
  assert.match(head(w.at(2)), /形に合わないので/);
  await w.send(ev.issue(3, "edited"));
  assert.deepEqual([/着手可能日時「来週」/.test(head(w.at(3))), w.titles().includes("#3 実装")], [true, false], "G7 形の合わない着手可能日時は知らせ、まだ先と読んで振り出さない");
  w.at(1).status = "完了";
  await w.send(ev.move(1));
  const told = w.at(1).comments.at(-1);
  assert.deepEqual([w.at(1).state, [`「${w.at(1).status}」`, "保留", "完了"].every((t) => told.includes(t))], ["OPEN", true], "G4 戻した先と、ユーザーが直接決められるのは保留と完了だけであることを知らせる");
});

// 回答フォームは App の名義で読み、答えはユーザーの名義（FORM_TOKEN）で書く。GitHub への要求は world へつなぐ。
const key = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]);
const env = { APP_ID: 1, APP_KEY: Buffer.from(await crypto.subtle.exportKey("pkcs8", key.privateKey)).toString("base64"), FORM_TOKEN: "user" };
function connect(w) {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace("https://api.github.com", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    const reply = (x, type = "application/json") => new Response(x == null ? null : type === "application/json" ? JSON.stringify(x) : x, { status: x == null ? 204 : 200, headers: { "content-type": type } });
    if (path.startsWith("/app/installations/")) return reply({ token: "app", expires_at: "2099-01-01T00:00:00Z" });
    if (path === "/graphql") return reply({ data: await w.gh.gql(body.query, body.variables) });
    if (path === "/markdown") return reply(`<p>${body.text}</p>`, "text/html");
    // 回答フォームは答えをユーザーの名義（FORM_TOKEN）で書く。
    return reply(await w.gh.rest(init.method, path, body, init.headers?.authorization === `Bearer ${env.FORM_TOKEN}` ? config.user : config.gateBot));
  };
}
const url = (n) => `${config.urls.form}/answer?issue=${n}`;
const open = (n) => answerForm(new Request(url(n)), env, config);
// ブラウザと同じく、開いたページの隠しの欄（問いの文・確かめの項目）と、選んだ値を送る。
async function answer(n, picks) {
  const html = await (await open(n)).text();
  const form = new FormData();
  for (const [, name, value] of html.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)">/g)) form.set(name, value.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c)));
  for (const [k, v] of Object.entries(picks)) (form.delete(k), [v].flat().forEach((x) => form.append(k, x)));
  return (await answerForm(new Request(url(n), { method: "POST", body: form }), env, config)).json();
}

// ユーザーが書いた文（答えの文・コメント）は、必ず Claude が読んでから進む（#724 の確かめの答えの文が、読まれずに閉じて消えた）。
test("書いた文は Claude が読むまで決定を当てず、読んだあとに一度だけ当てて知らせる", async () => {
  const done = "## 回答\n**完成にしてよいですか？**\n\n回答: 完了にする\n- 確かめた: 見た目\n\n距離のバーは候補数の横に置いて";
  const w = world([{ n: 1, status: "回答", body: CONFIRM, comments: [ASKED("確かめ"), done] }]);
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).state, w.at(1).status, w.titles()], ["OPEN", "実装", ["#1 実装"]], "#724: 完了にしても文があれば閉じず、実装担当が読む");
  Object.assign(w.at(1), { body: `${CONFIRM}- [ ] 距離のバーを候補数の横へ置く\n`, pr: { draft: true, checks: "PENDING" } }); // 担当が読んで条件に足し、作った
  w.at(1).comments.push(END(2));
  await w.send(ev.run(w.run(1), "completed"));
  assert.deepEqual([w.at(1).body.includes("- [x] 見た目"), w.at(1).state, w.at(1).status, head(w.at(1))], [true, "OPEN", "検査", `${APPLIED}（完了）。`],
    "読んだあとに答え（完了にする）を当てて確かめた行にチェックを付け、当てたことを知らせる。足した条件が残るので閉じない");
  await w.send(ev.comment(1, config.claude));
  assert.equal(w.at(1).comments.filter((c) => c.startsWith(APPLIED)).length, 1, "答えは一度だけ当てる");

  const drop = world([{ n: 2, status: "回答", author: config.claude, type: "要望",
    comments: [ASKED("採否"), "## 回答\n**このタスクに着手しますか？**\n\n回答: 見送る\n\n代わりにパネル全体を2列にしたい"] }]);
  await drop.send(ev.comment(2));
  assert.deepEqual([drop.at(2).state, drop.at(2).status], ["OPEN", "実装"], "見送るでも文があれば、閉じる前に実装担当が読む");
  drop.at(2).comments.push(END(2));
  await drop.send(ev.run(drop.run(2), "completed"));
  assert.deepEqual([drop.at(2).state, drop.at(2).reason, head(drop.at(2))], ["CLOSED", "NOT_PLANNED", `${APPLIED}（見送り）。`], "読んだあとに見送りで閉じる");

  const late = world([{ n: 3, status: "完了", state: "CLOSED", reason: "COMPLETED", body: "- [x] 作る\n", closedAt: T(0.5), comments: [END(0), "ここも直して"], by: [undefined, config.user] }]);
  await late.send(ev.comment(3));
  assert.deepEqual([late.at(3).state, late.at(3).status], ["OPEN", "実装"], "閉じたあとのコメントは、開き直して実装担当が読む");
  late.at(3).comments.push(END(2));
  await late.send(ev.run(late.run(3), "completed"));
  assert.deepEqual([late.at(3).state, late.at(3).reason], ["CLOSED", "COMPLETED"], "読んで条件が全部済んでいれば、完成で閉じ直す");

  const closing = world([{ n: 4, status: "実装", state: "CLOSED", reason: "NOT_PLANNED", comments: ["やめる"], by: [config.user] }]);
  await closing.send(ev.issue(4, "closed"));
  assert.equal(closing.at(4).state, "CLOSED", "閉じるときに一緒に書いた文は、閉じる決定の一部（開き直さない）");

  const mid = world([{ n: 5, status: "実装" }]);
  await mid.send(ev.schedule());
  const run = mid.run(5);
  mid.at(5).comments.push("途中で書いた");
  mid.at(5).by[0] = config.user;
  mid.at(5).comments.push(END(0)); // 担当は書かれる前に読み始めた
  await mid.send(ev.run(run, "completed"));
  assert.deepEqual([mid.at(5).status, mid.titles()], ["実装", ["#5 実装", "#5 実装"]], "担当が読み始めたあとに書いた文は、次の担当が読む");

  const dialog = world([{ n: 6, status: "回答", type: config.dialogType, comments: [QUESTION, ANSWER("回答: 保留する\n\n来週にする")] }]);
  await dialog.send(ev.comment(6));
  assert.deepEqual([dialog.at(6).status, dialog.titles()], ["実装", []], "対話作業: 文があれば開発機のセッションの番（振り出さない）");
  dialog.at(6).comments.push("来週に回すと読んだ");
  await dialog.send(ev.comment(6, config.claude));
  assert.deepEqual([dialog.at(6).status, head(dialog.at(6))], ["保留", `${APPLIED}（保留）。`], "対話作業: Claude が書いたら読んだとして、答えを当てる");
});

test("回答フォーム（R10〜R12・決め2・合意したモック）: 問いの節から選ぶ欄を導き、次のステータスは出さない。送った答えでゲートが決め直す", async () => {
  const w = world([{ n: 1, status: "検査", body: CONFIRM, pr: { state: "MERGED", merged: true, mergeChecks: "SUCCESS", sha: "m1" } },
    { n: 2, author: config.claude, type: "要望" }, { n: 3, status: "実装" }, { n: 4, status: "回答", comments: [QUESTION] },
    { n: 5, status: "回答", comments: [END(0), ASKED("イレギュラー")] }]);
  connect(w);
  await w.send(ev.ci(config.base, "m1")); // 確かめの問い
  await w.send(ev.issue(2, "opened", config.claude)); // 採否の問い
  const check = await (await open(1)).text();
  for (const text of ["項目", "見た目", "完了にする（上の全部）", "書くこと", "確認", "戻る", "送信", "判断材料"]) assert.ok(check.includes(text), `確かめ: ${text}`);
  for (const text of ["次のステータス", "問題なし", "問題あり"]) assert.ok(!check.includes(text), `確かめ: ${text} は出さない`);
  assert.match(check, /<textarea name="note" rows="4"/, "書く欄は1つで4行");
  const adopt = await (await open(2)).text();
  for (const text of ["着手する", "保留する", "見送る"]) assert.ok(adopt.includes(text), `採否: ${text}`);
  assert.ok((await (await open(4)).text()).includes("どれでもない（書く欄に書く）"), "判断: 案と、どれでもない（書く欄に書く）");
  const irregular = await (await open(5)).text();
  for (const text of ["やり直す", "保留する", "見送る"]) assert.ok(irregular.includes(text), `イレギュラー: ${text}`);
  assert.equal((await open(3)).status, 404, "答えていない問いが無い");
  assert.match((await answer(1, { question: "前の問い" })).error, /問いが新しくなっています/);
  assert.match((await answer(1, {})).error, /「完了にする」のチェックを付けるか、書く欄に書いてください/, "確かめは、完了にするか書くかのどちらかが要る");
  assert.match((await answer(4, { choice: "どれでもない（書く欄に書く）" })).error, /書く欄に書いてください/);
  await answer(1, { note: "崩れる" });
  assert.match(w.at(1).comments.at(-1), /\n\n崩れる$/, "書いた文は形を付けずにそのまま置く");
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).state, w.at(1).status, w.titles().filter((t) => t.startsWith("#1"))], ["OPEN", "実装", ["#1 実装"]], "決め2 書いた文は実装担当が読む（完成にしない）");
  await answer(2, { choice: "見送る", label: ["急ぎ"] });
  await w.send(ev.comment(2));
  assert.deepEqual([w.at(2).state, w.at(2).reason, w.at(2).labels], ["CLOSED", "NOT_PLANNED", ["急ぎ"]], "採否の見送るで閉じる。ラベルの付け外しも送る");
});

// tasks#892: 問いの形は種類ごとのファイルにあり、回答フォームは問いの節だけから導く（書く者が埋める問いは test/forms.js: formed で作る）。
const MATERIAL = (kind) => SKELETON[kind].slice(SKELETON[kind].indexOf("<details>"));

test("tasks#892 問いの形は種類ごとに5つあり、問いはその種類の形と照らす（案の無い判断・決まった文や案を変えた問い・知らない種類は読まない）", () => {
  const forms = config.questionForms;
  assert.deepEqual(Object.keys(forms).sort(), ["イレギュラー", "判断", "採否", "操作", "確かめ"].sort());
  const ok = [askText("採否", forms), askText("確かめ", forms, [{ text: "見た目" }]), askText("イレギュラー", forms), askDropped([7], forms),
    FORMED("判断", "どちらにしますか？", ["A", "B"]), FORMED("操作", "設定を変えてください", ["画面で設定を変える"])];
  for (const text of ok) assert.deepEqual(checkQuestion(forms, text), [], text.split("\n")[0]);
  const judge = FORMED("判断", "どちらにしますか？", ["A", "B"]);
  const rows = [
    ["案の無い判断", `## 問い（判断）\nどちらにしますか？\n\n${MATERIAL("判断")}`, /判断の答えの節は「### 案」/],
    ["項目で答える判断", judge.replace("### 案", "### 項目"), /判断の答えの節は「### 案」/],
    ["案で答える操作", FORMED("操作", "設定を変えてください", ["画面で設定を変える"]).replace("### 項目", "### 案"), /操作の答えの節は「### 項目」/],
    ["採否の決まった案を変えた", askText("採否", forms).replace("- 見送る", "- やめる"), /採否の「### 案」は 着手する・保留する・見送る/],
    ["確かめの決まった問いの文を変えた", askText("確かめ", forms, [{ text: "見た目" }]).replace("完成にしてよいですか？", "閉じますか？"), /確かめの問いの文は「完成にしてよいですか？」/],
    ["前の形の判断材料の節（案ごとに起きること）", judge.replace("**答えごとに起きること**", "**案ごとに起きること**"), /判断材料の節は/],
    ["種類の無い頭", judge.replace("## 問い（判断）", "## 問い"), /頭の行/],
    ["知らない種類", judge.replace("## 問い（判断）", "## 問い（相談）"), /種類は .*のどれか/],
  ];
  for (const [name, text, want] of rows) assert.match(checkQuestion(forms, text).join("・"), want, name);
});

test("tasks#892 種類「操作」の問いを出すと、回答フォームに項目の一覧と「済ませた」のチェック1つが出て、済ませたら Claude の番へ戻る", async () => {
  const asked = FORMED("操作", "秘密の値を入れ直してください", ["Cloudflare の画面で秘密の値を入れ直す"]);
  const w = world([{ n: 1, status: "実装", comments: [asked] }]);
  connect(w);
  await w.send(ev.comment(1, config.claude));
  assert.deepEqual([w.at(1).status, w.at(1).assignees, w.at(1).labels], ["回答", [config.user], ["問い: 操作"]]);
  const html = await (await open(1)).text();
  for (const text of ["項目", "Cloudflare の画面で秘密の値を入れ直す", "済ませた（上の全部）"]) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('type="radio"'), "選ぶ案は出さない");
  assert.match((await answer(1, {})).error, /「済ませた」のチェックを付けるか/);
  await answer(1, { done: "on" });
  assert.match(w.at(1).comments.at(-1), /\n\n回答: 済ませた\n- 確かめた: Cloudflare の画面で秘密の値を入れ直す$/);
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).status, w.titles(), w.at(1).labels], ["実装", ["#1 実装"], []], "済ませたら実装担当へ渡し、問いのラベルを外す");
});

test("tasks#892 回答フォームは種類で分けず、問いの答えの節と形の答えの意味だけから選ぶ欄を導く（形を足しても、フォームは変えずに出せる）", async () => {
  const form = (kind, header, rows, more = "") => `出す者: ゲート\n${more}\n## 問い（${kind}）\n読みましたか？\n\n${header}\n${rows.map((r) => `- ${r}`).join("\n")}\n\n` +
    "<details><summary>判断材料</summary>\n\n**何の話か**: 試しの種類です。\n</details>\n";
  const added = loadForms([form("知らせ", "### 案", ["読んだ", "あとで読む"], "答えの意味: あとで読む: 保留\n"), form("相談", "### 案", ["<案>"]),
    form("点検", "### 項目", ["<点検すること>"], "答えの意味: 見た: 完了\n")]);
  const cfg = { ...config, questionForms: { ...config.questionForms, ...added } };
  const w = world([{ n: 1, status: "回答", comments: [askText("知らせ", added)] },
    { n: 2, status: "回答", comments: ["## 問い（相談）\n読みましたか？\n\n### 案\n- 先に読む\n- 後で読む\n\n<details><summary>判断材料</summary>\n\n**何の話か**: 相談です。\n</details>"] },
    { n: 3, status: "回答", comments: [askText("点検", added, [{ text: "地図の色" }])] }]);
  connect(w);
  const page = async (n) => (await answerForm(new Request(url(n)), env, cfg)).text();
  const fixed = await page(1);
  assert.ok(/<div class="seg">.*読んだ.*あとで読む.*<\/div>/s.test(fixed) && !fixed.includes("どれでもない"), "形が決めた案は横並びの区切りで、どれでもないは添えない");
  const open2 = await page(2);
  assert.ok(!open2.includes('class="seg"') && ["先に読む", "後で読む", "どれでもない（書く欄に書く）"].every((t) => open2.includes(`type="radio" name="choice" value="${t}"`)),
    "書く者が立てた案は1行ずつの丸に、どれでもないを添える");
  const items = await page(3);
  assert.ok(items.includes("<li>地図の色") && items.includes("見た（上の全部）") && !items.includes('type="radio"'), "項目は一覧と、形が決めた文のチェック1つ");
  for (const html of [fixed, open2, items]) assert.match(html, /<textarea name="note" rows="4"/, "書く欄はいつも出す");
  assert.equal(latestQuestion([askText("知らせ", added), "## 回答\n**読みましたか？**\n\n回答: あとで読む"], cfg.questionForms).answer.decision, "保留", "答えの決定は形の答えの意味で引く");
});

test("tasks#892 答えの無い問いがある間だけ、ゲートがラベル「問い: <種類>」を付け、答えが当たったら外す。回答フォームのラベルの欄には出さない", async () => {
  const left = "- [x] 作る\n- [ ] 見た目\n  - 確かめる: ユーザー\n- [ ] 直す\n";
  const w = world([{ n: 2, author: config.claude, type: "要望" }, { n: 3, status: "回答", labels: ["問い: 確かめ"], body: withButton(left, config, 3), comments: [ASKED("確かめ")] },
    { n: 4, status: "回答", labels: ["急ぎ", "問い: 判断"], comments: [END(0), ASKED("イレギュラー")] },
    { n: 5, status: "実装", comments: [`## 問い（判断）\nどちらにしますか？\n\n${MATERIAL("判断")}`] }], { workflow: "disabled" });
  connect(w);
  await w.send(ev.issue(2, "opened", config.claude));
  assert.deepEqual(w.at(2).labels, ["問い: 採否"], "採否を問うたら付ける");
  const html = await (await open(2)).text();
  assert.ok(html.includes('value="急ぎ"') && !html.includes('value="問い: 採否"'), "ラベルの欄に問いのラベルは出さない");
  await answer(2, { choice: "着手する", label: ["急ぎ"] });
  assert.deepEqual(w.at(2).labels, ["問い: 採否", "急ぎ"], "フォームで送っても、問いのラベルは外さない");
  await w.send(ev.comment(2));
  assert.deepEqual(w.at(2).labels, ["急ぎ"], "答えが当たったら外す");
  await w.send(ev.issue(3, "edited", config.claude));
  assert.deepEqual([w.at(3).status, w.at(3).labels], ["実装", []], "問いを出した事実が無くなったら外す");
  await w.send(ev.comment(4, config.claude));
  assert.deepEqual(w.at(4).labels, ["急ぎ", "問い: イレギュラー"], "違う種類のラベルは、今の問いの種類へ揃える");
  await w.send(ev.comment(5, config.claude));
  assert.deepEqual([w.at(5).labels, /判断の答えの節は「### 案」/.test(w.at(5).comments.at(-1))], [[], true], "形に合わない問い（案の無い判断）は読まず、付けない");
});
