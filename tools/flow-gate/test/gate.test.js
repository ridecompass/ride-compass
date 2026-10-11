// ゲートを入口から、tasks#788 の要求とユーザーと決めた約束（tasks#799）で確かめる。出来事は受け箱（src/inbox.js: Inbox）に入れて本物と同じ処理
// （src/flow.js: handle）で、回答フォームは HTTP の要求（src/form.js: answerForm）で動かし、ボード・コメント・本文・PR・ラベル・実行・状況の更新を見る。
// 期待は要求の文から書く（各行・各 assert の名前）。GitHub の代わりの world は、置き場の issue・ボード・作業ブランチの PR・担当の実行を持つ。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import base from "../flow.config.json" with { type: "json" };
import { handle } from "../src/flow.js";
import { answerForm } from "../src/form.js";
import { Inbox } from "../src/inbox.js";
import { Patrol } from "../src/patrol.js";
import { APPLIED, answerBody, askDropped, askText, conditions, droppedQuestion, withButton } from "../src/questions.js"; // 本物のボタンと、ゲートの問いの形を入力に使う

// 時計は差し替える（動きの確かめが読む今の時刻）。既定はコメントの時刻（下の T）の1時間後で、止まりを見る場面だけ進める。
const clock = { now: Date.UTC(2026, 9, 11, 1) };
const config = { ...base, questionTemplate: readFileSync(new URL("../question_template.md", import.meta.url), "utf8"), slots: { 作る: 2, 確かめる: 1 }, now: () => clock.now };
const OPTIONS = ["未着手", "進行中", "CI待ち", "検証待ち", "検証中", "回答待ち", "保留", "完了", "高", "中", "低"].map((name) => ({ id: name, name }));
const tasks = { full_name: config.tasks };
const code = { full_name: config.code };
const names = (list) => ({ nodes: list.map((name) => ({ name })) });
// コメントの時刻は並びの順（k 番目は k 秒）。書いた人は、置いたときに決めたもの（i.by）か、答え（## 回答）ならユーザー、ほかは Claude。
const T = (k) => new Date(Date.UTC(2026, 9, 11) + k * 1000).toISOString();
const author = (i, k) => i.by[k] ?? (i.comments[k].startsWith("## 回答") ? config.user : config.claude);
// 担当の終わりのコメント（.github/claude-task/after.js）。start は担当が読み始めたときのコメントの数（それより前を読んでいる）。
const END = (start) => `### 作る担当の終わり\n\n要約（担当の最後の発言）:\n\n> 読んだ\n\n読み始め: ${T(start - 0.5)}`;

function world(list, { workflow = "active", last = [], steps = [] } = {}) {
  const w = { issues: new Map(), runs: [], writes: [], updates: [] };
  for (const i of list) w.issues.set(i.n, { state: "OPEN", reason: null, body: "- [ ] 作る\n", author: config.user, type: null, assignees: [], blockedBy: [],
    comments: [], by: [], closedAt: null, status: null, priority: null, start: null, board: "actions", parent: null, labels: [], pr: null, ...i });
  w.at = (n) => w.issues.get(n);
  const item = (i) => (i.board ? [{ id: `IT${i.n}`, project: { number: config.boards[i.board] }, status: i.status && { name: i.status },
    priority: i.priority && { name: i.priority }, start: i.start && { text: i.start } }] : []);
  const near = (n) => ({ number: n, state: w.at(n).state, stateReason: w.at(n).reason });
  const blocked = (i) => ({ nodes: i.blockedBy.map(near) });
  const children = (i) => ({ nodes: [...w.issues.values()].filter((k) => k.parent === i.n).map((k) => near(k.n)) });
  // 矢印1本でつながる issue（src/facts.js: relationsOf の形）。
  const relations = (i) => {
    const p = i.parent && w.at(i.parent);
    return { blockedBy: blocked(i), subIssues: children(i), parent: p && { ...near(p.n), body: p.body, labels: names(p.labels), projectItems: { nodes: item(p) } } };
  };
  const pull = (i, p) => ({ id: `PR${i.n}`, state: p.state ?? "OPEN", isDraft: p.draft, merged: Boolean(p.merged), mergeCommit: { statusCheckRollup: p.mergeChecks && { state: p.mergeChecks } },
    commits: { nodes: [{ commit: { oid: `c${i.n}`, committedDate: "2026-10-11T00:00:00Z", statusCheckRollup: p.checks && { state: p.checks } } }] },
    timelineItems: { nodes: p.drafted ? [{ createdAt: "2026-10-11T01:00:00Z" }] : [] } });
  const gql = async (q, v) => {
    if (q.includes("fields(first:30")) return { organization: { projectV2: { id: `P${v.n}`, fields: { nodes: [config.fields.status, config.fields.priority].map((name) => ({ id: name, name, options: OPTIONS })) } } } };
    if (q.includes("closePullRequest")) return void (w.at(Number(v.id.slice(2))).pr.state = "CLOSED", w.writes.push(["PR を閉じる", Number(v.id.slice(2))]));
    if (q.includes("removeSubIssue")) return void (w.at(Number(v.c.slice(1))).parent = null, w.writes.push(["親子を外す", Number(v.c.slice(1))]));
    if (q.includes("c:issue(number:$c)")) return { repository: { p: { parent: w.at(v.p).parent && { number: w.at(v.p).parent } }, c: { subIssues: children(w.at(v.c)) } } };
    if (q.includes("items(first:100")) return { organization: { projectV2: { items: { pageInfo: { hasNextPage: false }, nodes: [...w.issues.values()].filter((i) => i.board === "actions")
      .map((i) => ({ ...item(i)[0], content: { number: i.n, state: i.state, issueType: i.type && { name: i.type }, labels: names(i.labels), ...relations(i) } })) } } } };
    if (q.includes("blocking(")) {
      const i = w.at(v.n);
      return { repository: { issue: { blocking: { nodes: [...w.issues.values()].filter((k) => k.blockedBy.includes(v.n)).map((k) => ({ number: k.n, state: k.state })) },
        parent: i.parent && { number: i.parent, state: w.at(i.parent).state }, subIssues: { nodes: children(i).nodes.map(({ number, state }) => ({ number, state })) } } } };
    }
    if (q.includes("bodyHTML")) { // 回答フォームの読み（src/form.js）
      const i = w.at(v.i);
      return { repository: { labels: names(["急ぎ", "要確認"]), issue: { id: `I${i.n}`, title: "タスク", url: `https://github.test/${i.n}`, body: i.body, labels: names(i.labels),
        comments: { nodes: i.comments.map((body) => ({ body, bodyHTML: body, url: "https://github.test/c", createdAt: "2026-10-11T00:00:00Z", author: { login: "x" } })) } } } };
    }
    if (q.includes("t:repository")) {
      const i = w.at(v.n);
      // 閉じた時刻を置いていない閉じた issue は、今あるコメントのあとに閉じた。
      const closedAt = i.state === "CLOSED" ? (i.closedAt ?? T(i.comments.length - 0.5)) : null;
      const comments = i.comments.map((body, k) => ({ body, createdAt: T(k), author: { login: author(i, k) } })).slice(-40);
      return { t: { issue: { id: `I${i.n}`, state: i.state, stateReason: i.reason, createdAt: T(0), closedAt, body: i.body, author: { login: i.author }, issueType: i.type && { name: i.type },
        assignees: { nodes: i.assignees.map((login) => ({ login })) }, ...relations(i), comments: { nodes: comments }, projectItems: { nodes: item(i) },
        timelineItems: { nodes: (i.typeChanges ?? []).map(([a, b]) => ({ prevIssueType: { name: a }, issueType: { name: b } })) } } },
      c: { pullRequests: { nodes: i.pr ? [pull(i, i.pr)] : [] } } };
    }
    if (q.includes("statusUpdates")) return { node: { statusUpdates: { nodes: w.updates.slice(-1) } } };
    if (q.includes("node(id:")) return { node: { number: Number(v.id.slice(1)) } };
    if (q.includes("updateProjectV2ItemFieldValue")) return void (w.at(Number(v.i.slice(2)))[v.f === config.fields.status ? "status" : "priority"] = v.v);
    if (q.includes("addProjectV2ItemById")) {
      w.at(Number(v.c.slice(1))).board = Object.keys(config.boards).find((k) => v.p === `P${config.boards[k]}`);
      return { addProjectV2ItemById: { item: { id: `IT${v.c.slice(1)}` } } };
    }
    if (q.includes("markPullRequestReadyForReview")) return void (w.at(Number(v.id.slice(2))).pr.draft = false);
    if (q.includes("createProjectV2StatusUpdate")) return void w.updates.push({ status: v.s, body: v.b });
    throw new Error(`知らない問い合わせ: ${q.slice(0, 80)}`);
  };
  const rest = async (method, path, body, who = config.gateBot) => {
    let m;
    if (path.endsWith(`/workflows/${config.workflow}`)) return { state: workflow };
    if (path.includes("/runs?status=completed&per_page=1")) return { workflow_runs: last };
    if (path.endsWith("/jobs")) return { jobs: [{ steps }] };
    if (path.startsWith("/search/issues")) return { items: [...w.issues.values()].filter((i) => i.state === "OPEN" && !i.assignees.includes(config.user)).map((i) => ({ number: i.n })) };
    if (path.endsWith("/dispatches")) return void w.runs.push({ id: 100 + w.runs.length, display_title: `#${body.inputs.issue} ${body.inputs.kind} ${body.inputs.key}` });
    if ((m = /\/actions\/runs\/(\d+)\/cancel$/.exec(path))) return void w.writes.push(["取り消し", Number(m[1])]);
    if ((m = /\/commits\/(\w+)\/pulls$/.exec(path))) return [...w.issues.values()].filter((i) => i.pr?.sha === m[1]).map((i) => ({ head: { ref: `${config.branchPrefix}${i.n}` } }));
    if ((m = /\/commits\/c(\d+)\/check-runs/.exec(path))) return { check_runs: w.at(Number(m[1])).survivors ? [{ id: Number(m[1]), completed_at: "2026-10-11T00:00:00Z" }] : [] };
    if ((m = /\/check-runs\/(\d+)\/annotations/.exec(path))) return w.at(Number(m[1])).survivors.map((message) => ({ title: "テストが気づかない書き換え", path: "src/a.js", message }));
    if ((m = /\/issues\/(\d+)\/comments\?per_page=100&page=(\d+)$/.exec(path))) return w.at(Number(m[1])).comments.slice((m[2] - 1) * 100, m[2] * 100).map((b) => ({ body: b }));
    if ((m = /\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(path))) {
      const i = w.at(Number(m[1]));
      return void (i.labels = m[2] ? i.labels.filter((l) => l !== decodeURIComponent(m[2])) : [...i.labels, ...body.labels]);
    }
    const i = w.at(Number(/\/issues\/(\d+)/.exec(path)[1]));
    if (path.endsWith("/comments")) return void (i.by[i.comments.length] = who, i.comments.push(body.body), w.writes.push(["コメント", i.n, body.body.split("\n")[0]]));
    if (body.body !== undefined) w.writes.push(["本文", i.n]);
    const closing = body.state ? { state: body.state.toUpperCase(), reason: body.state_reason?.toUpperCase() ?? null, closedAt: body.state === "closed" ? T(i.comments.length - 0.5) : null } : {};
    return void Object.assign(i, closing, body.body !== undefined ? { body: body.body } : {},
      body.type ? { type: body.type } : {}, body.assignees ? { assignees: body.assignees } : {});
  };
  w.gh = { gql, rest };
  // 置き場は Durable Object の置き場と同じ口（get・put・delete・前方一致の list）をメモリで持つ。受け箱と見回りは本物。
  const memory = new Map();
  const storage = { get: async (k) => memory.get(k), put: async (k, v) => void memory.set(k, v), delete: async (k) => [k].flat().forEach((x) => memory.delete(x)),
    list: async ({ prefix }) => new Map([...memory].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))) };
  const patrol = new Patrol(storage);
  w.inbox = new Inbox(storage, (name, payload) => (w.fail ? Promise.reject(w.fail) : handle(w.gh, { patrol, inbox: w.inbox }, config, name, payload)));
  w.push = ([name, payload]) => w.inbox.push(name, payload);
  w.send = async (event) => (await w.push(event), w.inbox.drain(config.retries));
  w.titles = () => w.runs.map((r) => r.display_title.split(" ").slice(0, 2).join(" "));
  w.run = (n) => w.runs.findLast((r) => r.display_title.startsWith(`#${n} `));
  return w;
}
const ev = {
  run: (r, action) => ["workflow_run", { action, sender: { login: config.gateBot }, repository: code, workflow_run: { id: r.id, path: `.github/workflows/${config.workflow}`, display_title: r.display_title } }],
  ci: (branch, sha = "x") => ["workflow_run", { action: "completed", sender: { login: config.user }, repository: code, workflow_run: { id: 1, path: ".github/workflows/ci.yml", head_branch: branch, head_sha: sha } }],
  comment: (n, login = config.user) => ["issue_comment", { action: "created", sender: { login }, issue: { number: n }, repository: tasks }],
  issue: (n, action, login = config.user, more = {}) => ["issues", { action, sender: { login }, issue: { number: n, body: more.body }, changes: more.changes, repository: tasks }],
  pr: (n, action) => ["pull_request", { action, sender: { login: config.user }, repository: code, pull_request: { head: { ref: `${config.branchPrefix}${n}` } } }],
  move: (n) => ["projects_v2_item", { action: "edited", sender: { login: config.user }, changes: { field_value: { field_name: config.fields.status } },
    projects_v2_item: { project_node_id: `P${config.boards.actions}`, content_node_id: `I${n}` } }],
  schedule: () => ["schedule", {}],
  sub: (p, c, action = "sub_issue_added") => ["sub_issues", { action, sender: { login: config.claude }, repository: tasks,
    parent_issue: { number: p, node_id: `I${p}` }, sub_issue: { number: c, node_id: `I${c}` } }],
};
const head = (i) => i.comments.at(-1)?.split("\n")[0] ?? null;
const QUESTION = config.questionTemplate; // 形どおりの判断の問い
const ANSWER = (line) => `## 回答\n**${QUESTION.split("\n")[1]}**\n\n${line}`;
const CONFIRM = "- [x] 作る\n- [ ] 見た目\n  - 確かめる: ユーザー\n";
const ASKED = (kind) => askText(kind, config.questionTemplate); // ゲートが出す問い

test("R2・R17・R14・K1: 振り出したその場で進行中（順番待ちを含む）。同時に届いた出来事でも、1つのタスクに担当は1人で、枠の数まで急ぎ・優先度の順", async () => {
  const w = world([{ n: 1, status: "未着手", priority: "低" }, { n: 2, status: "未着手", labels: [config.urgentLabel] }, { n: 3, status: "未着手", priority: "高" },
    { n: 4, status: "未着手", blockedBy: [9] }, { n: 5, status: "未着手", start: "2099-01-01" }, { n: 9, status: "保留" }]);
  await Promise.all([w.push(ev.schedule()), w.push(ev.schedule()), w.push(ev.comment(1))]);
  await w.inbox.drain(config.retries);
  assert.deepEqual(w.titles().sort(), ["#2 作る", "#3 作る"]);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => w.at(n).status), ["未着手", "進行中", "進行中", "未着手", "未着手", "保留"]);
  await w.send(ev.run(w.run(2), "requested"));
  await w.send(ev.run({ id: 7, display_title: "#2 作る" }, "completed"));
  assert.equal(w.at(2).status, "進行中", "別の実行（手で起こした実行）の終わりで、今の担当を手放さない");
  await w.send(ev.run(w.run(3), "completed"));
  await w.send(ev.run(w.run(3), "in_progress"));
  assert.deepEqual([w.at(3).status, head(w.at(3))], ["回答待ち", "## 問い（イレギュラー）"], "終わったあとに届いた始まりの知らせで持ち直さない");
});

test("R3・決め1・決め7: 担当の実行が終わったら、表の上から最初に当たる行で決める", async () => {
  const verify = { status: "検証待ち", pr: { draft: false, checks: "SUCCESS" } };
  const rows = [
    // [要求, 始まりのタスク, 終わったときの事実, ステータス, 起きた担当の数, 最後のコメントの頭]
    ["R3a 答えの無い問い", {}, { comments: [QUESTION] }, "回答待ち", 1, "## 問い（判断）"],
    ["R3b 下書きの PR の CI が終わっていない", {}, { pr: { draft: true, checks: "PENDING" } }, "CI待ち", 1, null],
    ["R3c・原則の点検の3 下書きでない PR の CI が通った → 検証待ち → 確かめる担当", {}, { pr: { draft: false, checks: "SUCCESS" } }, "検証中", 2, null],
    ["R3d 確かめる担当が下書きへ戻した（差し戻し）→ 作る担当", verify, { pr: { draft: true, checks: "SUCCESS", drafted: true } }, "進行中", 2, null],
    ["確かめる担当が、マージも差し戻しも問いもせずに手放した → イレギュラー", verify, {}, "回答待ち", 1, "## 問い（イレギュラー）"],
    ["R3e 条件が全部済んだ → 完成で閉じる", {}, { body: "- [x] 作る\n" }, "完了", 1, null],
    ["R3f 残りがユーザーの確かめだけ", {}, { body: CONFIRM }, "回答待ち", 1, "## 問い（確かめ）"],
    ["R3g 開いた前提", {}, { blockedBy: [9] }, "未着手", 1, null],
    ["R3g 未来の着手可能日時", {}, { start: "2099-01-01" }, "未着手", 1, null],
    ["決め3 作る担当が CI の結果のあとに持って見た生き残りは通す → 検証待ち → 確かめる担当", {}, { pr: { draft: true, checks: "SUCCESS" }, survivors: ["書き換え"] }, "検証中", 2, null],
    ["R3h どれでもない（落ちた）→ 黙って振り出し直さない", {}, {}, "回答待ち", 1, "## 問い（イレギュラー）"],
    ["決め1 マージのあとの残り", {}, { pr: { state: "MERGED", merged: true, mergeChecks: "SUCCESS" } }, "進行中", 2, null],
    ["マージのコミットの CI がまだ（本番に出る前に確かめを問わない）", {}, { body: CONFIRM, pr: { state: "MERGED", merged: true, mergeChecks: "PENDING" } }, "CI待ち", 1, null],
  ];
  for (const [name, start, facts, status, runs, comment] of rows) {
    const w = world([{ n: 1, status: "未着手", ...start }, { n: 9, status: "保留" }]);
    await w.send(ev.schedule());
    const run = w.run(1);
    await w.send(ev.run(run, "requested"));
    assert.equal(w.at(1).status, start.status ? "検証中" : "進行中", name);
    Object.assign(w.at(1), facts);
    await w.send(ev.run(run, "completed"));
    assert.deepEqual([w.at(1).status, w.runs.length, head(w.at(1))], [status, runs, comment], name);
    if (status === "回答待ち") assert.deepEqual([w.at(1).assignees, w.at(1).body.startsWith("<!-- flow-gate -->")], [[config.user], true], `${name}: ユーザーの番で、本文の頭に回答のボタン`);
  }
});

test("出来事1つで決め直す（R2・R4〜R9・R16・K2・K5・決め3・決め5・決め7・Claude の本文の書き換え）", async () => {
  const merged = { state: "MERGED", merged: true, mergeChecks: "SUCCESS", sha: "m1" };
  const rows = [
    // [要求, タスク, 担当が付いた後に変わる事実（無ければ担当なし）, 出来事, 期待]
    ["R4 PR の CI が落ちた → 未着手 → 同じ枝で直す作る担当", { status: "CI待ち", pr: { draft: true, checks: "FAILURE" } }, null, ev.ci(`${config.branchPrefix}1`), { status: "進行中", runs: ["#1 作る"] }],
    ["決め3 新しい変異テストの生き残り → 落ちたものと同じ", { status: "CI待ち", pr: { draft: true, checks: "SUCCESS" }, survivors: ["書き換え"] }, null, ev.ci(`${config.branchPrefix}1`), { status: "進行中", runs: ["#1 作る"] }],
    ["R4 PR の CI が通った → PR をレビュー可能にして検証待ち → 確かめる担当", { status: "CI待ち", pr: { draft: true, checks: "SUCCESS" } }, null, ev.ci(`${config.branchPrefix}1`), { status: "検証中", draft: false }],
    ["原則の点検の1 master の CI が落ちた → 本番に出ていないので確かめを問わず CI待ち", { status: "CI待ち", body: CONFIRM, pr: { ...merged, mergeChecks: "FAILURE" } }, null, ev.ci(config.base, "m1"), { status: "CI待ち", comment: null }],
    ["K2・R12 確かめの答えが完了にせず文だけ → 閉じず、Claude の番（作る担当が読む）", { status: "回答待ち", body: CONFIRM, comments: [ASKED("確かめ"), "## 回答\n**完成にしてよいですか？**\n\n見た目が崩れる"] }, null, ev.comment(1),
      { state: "OPEN", status: "進行中", runs: ["#1 作る"] }],
    ["決め6 前からある Claude の割り当ては外し、保留ではユーザーだけ", { status: "保留", assignees: [config.claude] }, null, ev.comment(1), { assignees: [config.user] }],
    ["R6 見送り（Close as not planned）で閉じたものは閉じたまま", { status: "完了", state: "CLOSED", reason: "NOT_PLANNED" }, null, ev.issue(1, "closed"), { state: "CLOSED" }],
    ["A 対話作業のボードは、開発機のセッションが触っていることを持たない（作業のステータスを書かない）", { status: "未着手", board: "dialog", type: config.dialogType, pr: { draft: true, checks: "PENDING" } }, null,
      ev.comment(1), { status: "未着手" }],
    ["R8 マージのコミットの master の CI が終わった → 確かめの問い", { status: "CI待ち", body: CONFIRM, pr: merged }, null, ev.ci(config.base, "m1"), { status: "回答待ち", comment: "## 問い（確かめ）" }],
    ["R8・決め7 CI が通ったあとに PR が下書きへ戻された（差し戻し）→ 未着手 → 作る担当", { status: "検証待ち", pr: { draft: true, checks: "SUCCESS", drafted: true } }, null, ev.pr(1, "converted_to_draft"), { status: "進行中", runs: ["#1 作る"] }],
    ["R5・決め1・決め6 判断の答えで続ける → 表で決め直して未着手 → 作る担当（ユーザーの番を出たら Claude の番）", { status: "回答待ち", assignees: [config.user], comments: [QUESTION, ANSWER("補足: A で")] }, null, ev.comment(1),
      { status: "進行中", runs: ["#1 作る"], assignees: [config.claude] }],
    ["R5・決め6 答えが保留 → 保留（ユーザーの番）", { status: "回答待ち", comments: [QUESTION, ANSWER("回答: 保留する")] }, null, ev.comment(1), { status: "保留", assignees: [config.user] }],
    ["R6・決め5 ユーザーが保留から出す → 表で決め直す", { status: "未着手" }, null, ev.move(1), { status: "進行中", runs: ["#1 作る"] }],
    ["R6 条件が全部済んでユーザーが完了へ動かす → 受ける（完成）", { status: "完了", body: "- [x] 作る\n" }, null, ev.move(1), { status: "完了", state: "CLOSED", reason: "COMPLETED" }],
    ["K2 条件が残ったまま完成で閉じた → 開き直す", { status: "保留", state: "CLOSED", reason: "COMPLETED" }, null, ev.issue(1, "closed"), { state: "OPEN" }],
    ["R7 担当が持っているタスクをユーザーが保留へ → その実行を取り消す", { status: "未着手" }, { status: "保留" }, ev.move(1), { status: "保留", cancels: [100], assignees: [config.user] }],
    ["R2・R13・K4 担当が付いている間は決め直さず、その間に出した問いのボタンも消さない", { status: "未着手" }, { comments: [QUESTION], body: withButton("- [ ] 作る\n", config, 1) }, ev.comment(1),
      { status: "進行中", runs: ["#1 作る"], button: true }],
    ["R9・R13 Claude が起こした要望は採否を問い、本文の頭のボタンは問いより先に書く", { author: config.claude, type: "要望", board: null }, null, ev.issue(1, "opened", config.claude),
      { status: "回答待ち", comment: "## 問い（採否）", writes: ["本文", "コメント"] }],
    ["R16 対話作業は別のボードへ入れ、振り出さない", { type: config.dialogType, board: null }, null, ev.issue(1, "opened"), { board: "dialog", status: "未着手", runs: [] }],
    ["子は優先度を自分の欄に持たない（親の値を見るので、書き写さない）", { board: null, parent: 4 }, null, ev.issue(1, "opened"), { priority: null, status: "未着手" }],
    ["R16 対話作業の境目をまたがない種類の変更は通す", { status: "保留", type: "要望", typeChanges: [["不具合", "要望"]] }, null, ev.issue(1, "typed"), { type: "要望" }],
    ["R16 対話作業の境目をまたぐ種類の変更は戻す", { status: "未着手", board: "dialog", type: "不具合", typeChanges: [[config.dialogType, "不具合"]] }, null, ev.issue(1, "typed"), { type: config.dialogType }],
    ["Claude が本文の完了の条件に印を付けた → 決め直す", { status: "未着手", body: "- [x] 作る\n" }, null, ev.issue(1, "edited", config.claude, { body: "- [x] 作る\n", changes: { body: { from: "- [ ] 作る\n" } } }), { status: "完了" }],
    ["条件の無い（子でない）issue は、今までどおり決め直しで完成で閉じる", { status: "未着手", body: "説明だけ\n" }, null, ev.comment(1), { state: "CLOSED", reason: "COMPLETED" }],
    ["回答のボタンだけを書き足した本文の書き換え → 受けない（問いの前にボタンを消さない）", { status: "未着手", body: withButton("- [ ] 作る\n", config, 1) }, null,
      ev.issue(1, "edited", config.claude, { body: withButton("- [ ] 作る\n", config, 1), changes: { body: { from: "- [ ] 作る\n" } } }), { status: "未着手", runs: [] }],
  ];
  for (const [name, task, change, event, want] of rows) {
    const w = world([{ n: 1, ...task }, { n: 4, status: "保留", priority: "高" }]);
    if (change) await w.send(ev.schedule()).then(() => w.send(ev.run(w.run(1), "requested")));
    Object.assign(w.at(1), change);
    await w.send(event);
    const i = w.at(1);
    const got = { status: i.status, state: i.state, reason: i.reason, type: i.type, board: i.board, priority: i.priority, assignees: i.assignees, comment: head(i), runs: w.titles(),
      draft: i.pr?.draft, button: i.body.startsWith("<!-- flow-gate -->"),
      cancels: w.writes.filter(([k]) => k === "取り消し").map(([, id]) => id), writes: w.writes.filter(([, n]) => n === 1).map(([k]) => k) };
    assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, got[k]])), want, name);
  }
});

test("tasks#842 担当者はユーザーに問わないと進めないかの2択で、Claude の番で待っていないのに3時間動かなければ、定時の決め直しでイレギュラーを問う", async () => {
  const HOUR = 3600e3;
  const start = Date.UTC(2026, 9, 11); // issue を作った時刻・コミットの時刻（足場の既定）
  const ci = { status: "CI待ち", pr: { draft: false, checks: "PENDING" } };
  const rows = [
    // [場面, タスク, 定時の時刻, ステータス, 担当者, 最後のコメントの頭, 足場の止め]
    ["CI が終わらないまま2時間 → まだ動いていると見る", ci, start + 2 * HOUR, "CI待ち", [config.claude], null],
    ["CI が終わらないまま3時間 → 止まった", ci, start + 3 * HOUR, "回答待ち", [config.user], "## 問い（イレギュラー）"],
    ["マージのあとの CI が落ちたまま（#797 の形）→ 止まった", { status: "CI待ち", body: CONFIRM, pr: { state: "MERGED", merged: true, mergeChecks: "FAILURE" } },
      start + 3 * HOUR, "回答待ち", [config.user], "## 問い（イレギュラー）"],
    ["前提が開いている（関係性で待つ）→ 何時間でも問わない", { status: "未着手", blockedBy: [9] }, start + 30 * HOUR, "未着手", [config.claude], null],
    ["振り出しを止めている（外の事情で待つ）→ 問わない", { status: "未着手" }, start + 30 * HOUR, "未着手", [config.claude], null, "disabled"],
    ["対話作業で3時間だれも書かない → 止まった", { status: "未着手", type: config.dialogType, board: "dialog" }, start + 3 * HOUR, "回答待ち", [config.user], "## 問い（イレギュラー）"],
    ["保留はユーザーの番で、確かめない", { status: "保留" }, start + 30 * HOUR, "保留", [config.user], null],
  ];
  for (const [name, task, now, status, assignees, comment, workflow = "active"] of rows) {
    const w = world([{ n: 1, ...task }, { n: 9, status: "保留" }], { workflow });
    clock.now = now;
    await w.send(ev.schedule());
    clock.now = Date.UTC(2026, 9, 11, 1);
    assert.deepEqual([w.at(1).status, w.at(1).assignees, head(w.at(1))], [status, assignees, comment], name);
  }
  // 止まりの問いに「やり直す」と答えたら、CI待ちのものは作る担当へ渡す。
  const w = world([{ n: 1, ...ci }]);
  clock.now = start + 3 * HOUR;
  await w.send(ev.schedule());
  clock.now = Date.UTC(2026, 9, 11, 1);
  const asked = w.at(1).comments.at(-1).split("\n");
  assert.deepEqual(asked.slice(0, 2), ["## 問い（イレギュラー）", "3時間、何も動いていません（最後の動き: 2026-10-11 09:00）。どうしますか？"]);
  w.at(1).comments.push(answerBody({ kind: "イレギュラー", text: asked[1] }, { choice: "やり直す" }));
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).status, w.titles(), w.at(1).assignees], ["進行中", ["#1 作る"], [config.claude]]);
});

test("前提が閉じたら、後ろで待っていたタスクも決め直して振り出す", async () => {
  const w = world([{ n: 6, status: "未着手", blockedBy: [7] }, { n: 7, status: "回答待ち", state: "CLOSED" }]);
  await w.send(ev.issue(7, "closed"));
  assert.deepEqual([w.at(6).status, w.titles()], ["進行中", ["#6 作る"]]);
});

// 分けたタスクの扱い（tasks#824）: 子は要望の値を親から継ぎ、条件を持たない。待つ相手は前提と子で、閉じたことと保留が矢印1本ずつ伝わる。
const asked = (i) => i.comments.filter((c) => c.startsWith("## 問い")).length;
const CHILD = "作る中身\n"; // 子は完了の条件を持たない

test("tasks#824 待つ相手: 開いた子がある親は、残りが確かめだけでも問わない。最後の子が完成で閉じたら子の行に印を付け、確かめを一度だけ問う", async () => {
  const w = world([{ n: 1, status: "未着手", body: "- [ ] 道を押すと値が出る（区間の境目を含む）\n  境目では両側の値\n  - 子: #2\n- [ ] 見た目\n  - 確かめる: ユーザー\n" },
    { n: 2, parent: 1, status: "未着手", body: CHILD }]);
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).status, asked(w.at(1))], ["未着手", 0], "#633: 子が開いている間は、親の確かめを問わない");
  Object.assign(w.at(2), { state: "CLOSED", reason: "COMPLETED" });
  await w.send(ev.issue(2, "closed"));
  assert.ok(w.at(1).body.includes("- [x] 道を押すと値が出る（区間の境目を含む）"), "子が受け持つ条件に印");
  assert.deepEqual([w.at(1).status, head(w.at(1)), asked(w.at(1))], ["回答待ち", "## 問い（確かめ）", 1]);
  await w.send(ev.comment(1));
  assert.equal(asked(w.at(1)), 1, "確かめは一度だけ");
  w.at(1).comments.push("## 回答\n**完成にしてよいですか？**\n\n回答: 完了にする\n- 確かめた: 見た目");
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).state, w.at(1).reason], ["CLOSED", "COMPLETED"]);
});

test("tasks#824 継承: 子は優先度・着手可能日時・急ぎ・保留を親の値で見る。条件の無い子は作っても閉じず、PR のマージのあと master の CI が通ったら閉じ、親へ伝わる", async () => {
  // 子の欄が空のままなら既定の「中」で並び、番号の小さい #3・#5 が先になる。親の値を見ると、高い親の子 #8 が先になる。
  const w = world([{ n: 1, status: "未着手", priority: "高", body: "- [ ] 動く\n  - 子: #8\n" }, { n: 8, parent: 1, body: CHILD, board: null },
    { n: 3, status: "未着手", priority: "中" }, { n: 4, status: "未着手", priority: "低", body: "- [ ] 動く\n  - 子: #5\n" }, { n: 5, parent: 4, status: "未着手", body: CHILD },
    { n: 9, status: "未着手", blockedBy: [1], body: CONFIRM }]);
  await w.send(ev.issue(8, "opened"));
  assert.deepEqual([w.at(8).state, w.at(8).priority], ["OPEN", null], "作ったとたんに閉じず、優先度の欄は空のまま");
  assert.deepEqual(w.titles().sort(), ["#3 作る", "#8 作る"], "高い親の子を、低い親の子より先に振り出す（親は子を待つ）");
  Object.assign(w.at(8), { pr: { state: "MERGED", merged: true, mergeChecks: "SUCCESS", sha: "m8" } });
  await w.send(ev.run(w.run(8), "completed"));
  assert.deepEqual([w.at(8).state, w.at(8).reason], ["CLOSED", "COMPLETED"]);
  assert.deepEqual([w.at(9).status, head(w.at(9))], ["回答待ち", "## 問い（確かめ）"], "子が閉じ → 親が閉じ → 親を待っていた issue まで、同じ出来事の中で決め直す");
  await w.send(ev.issue(8, "closed", config.gateBot)); // ゲートが閉じた出来事
  assert.deepEqual([w.at(1).state, w.at(1).reason, w.at(1).body.includes("- [x] 動く")], ["CLOSED", "COMPLETED", true], "子が受け持つ条件だけの親は、子が閉じたら閉じる");

  const v = world([{ n: 1, status: "保留", body: "- [ ] a\n  - 子: #2\n" }, { n: 2, parent: 1, status: "未着手", body: CHILD },
    { n: 3, status: "未着手", start: "2099-01-01", body: "- [ ] a\n  - 子: #4\n" }, { n: 4, parent: 3, status: "未着手", body: CHILD },
    { n: 5, status: "未着手", priority: "低", labels: [config.urgentLabel], body: "- [ ] a\n  - 子: #6\n" }, { n: 6, parent: 5, status: "未着手", body: CHILD },
    { n: 7, status: "未着手", priority: "高" }]);
  await v.send(ev.schedule());
  assert.deepEqual(v.titles().sort(), ["#6 作る", "#7 作る"], "保留の親の子・日時が先の親の子は振り出さず、急ぎの親の子を先に並べる");
  await v.send(ev.comment(2));
  assert.deepEqual([v.at(2).state, v.at(2).status], ["OPEN", "未着手"], "条件の無い子は、決め直しでもマージまで閉じない");
});

test("tasks#824 親が閉じたら: 開き直されない閉じ方なら、開いている子を見送りで閉じて知らせる（動いている実行も取り消す）", async () => {
  const w = world([{ n: 1, status: "未着手", body: "- [ ] a\n  - 子: #2\n" }, { n: 2, parent: 1, status: "未着手", body: CHILD }, { n: 3, status: "未着手", blockedBy: [2] }]);
  await w.send(ev.schedule());
  await w.send(ev.run(w.run(2), "requested"));
  Object.assign(w.at(1), { state: "CLOSED", reason: "COMPLETED", body: "- [x] a\n  - 子: #2\n" }); // ユーザーが「満たされた」と閉じた
  await w.send(ev.issue(1, "closed"));
  assert.deepEqual([w.at(2).state, w.at(2).reason, head(w.at(2)), w.writes.filter(([k]) => k === "取り消し").map(([, id]) => id)],
    ["CLOSED", "NOT_PLANNED", "親 #1 が閉じたので、見送りで閉じます。", [w.run(2).id]]);
  assert.deepEqual([w.at(3).status, head(w.at(3))], ["回答待ち", "## 問い（判断）"], "ゲートが閉じた子の先（その子を待つ issue）まで、同じ出来事の中で決め直す");
  for (const [name, parent, want] of [["条件の残る親を完成で閉じた → 親は開き直し、子はそのまま", { reason: "COMPLETED" }, ["OPEN", "OPEN"]],
    ["親を見送りで閉じた → 子も見送り", { reason: "NOT_PLANNED" }, ["CLOSED", "CLOSED"]]]) {
    const x = world([{ n: 1, status: "未着手", state: "CLOSED", body: "- [ ] a\n  - 子: #2\n", ...parent }, { n: 2, parent: 1, status: "保留", body: CHILD }]);
    await x.send(ev.issue(1, "closed"));
    assert.deepEqual([x.at(1).state, x.at(2).state], want, name);
  }
});

test("tasks#824 待つ相手が見送りで閉じたら、続けるかを一度だけ問う（前提でも子でも同じ）", async () => {
  const w = world([{ n: 6, status: "未着手", blockedBy: [7] }, { n: 7, status: "完了", state: "CLOSED", reason: "NOT_PLANNED" }]);
  await w.send(ev.issue(7, "closed"));
  assert.deepEqual([w.at(6).status, head(w.at(6)), w.at(6).comments.at(-1).includes(droppedQuestion([7]))], ["回答待ち", "## 問い（判断）", true]);
  w.at(6).comments.push(`## 回答\n**${droppedQuestion([7])}**\n\n回答: 続ける`);
  await w.send(ev.comment(6));
  assert.deepEqual([w.at(6).status, w.titles(), asked(w.at(6))], ["進行中", ["#6 作る"], 1], "続けると決めたら問い直さない");
  const x = world([{ n: 1, status: "未着手", body: "- [ ] a\n  - 子: #2\n" }, { n: 2, parent: 1, status: "完了", state: "CLOSED", reason: "NOT_PLANNED", body: CHILD }]);
  await x.send(ev.issue(2, "closed"));
  assert.deepEqual([x.at(1).status, head(x.at(1))], ["回答待ち", "## 問い（判断）"], "子が見送りなら、親で問う");
});

test("tasks#824 採否は親か分割元から受け継ぐ。子に書かれた完了の条件は知らせる。孫は張られた直後に外す", async () => {
  const w = world([{ n: 1, status: "未着手" }, { n: 2, author: config.claude, type: "要望", board: null, parent: 1, body: CHILD },
    { n: 3, author: config.claude, type: "要望", board: null, body: "分割元: #1\n- [ ] 作る\n" }, { n: 4, author: config.claude, type: "要望", board: null }]);
  for (const n of [2, 3, 4]) await w.send(ev.issue(n, "opened", config.claude));
  assert.deepEqual([2, 3, 4].map((n) => asked(w.at(n))), [0, 0, 1], "採否を問うのは、親も分割元も持たない新しい要望だけ");

  const x = world([{ n: 1, status: "未着手", body: "- [ ] a\n  - 子: #2\n" }, { n: 2, parent: 1, status: "保留", body: "- [ ] 何か\n" }]);
  await x.send(ev.issue(2, "edited"));
  await x.send(ev.comment(2));
  assert.deepEqual([head(x.at(2))?.startsWith("子は完了の条件を持ちません"), x.at(2).comments.length], [true, 1], "知らせは一度だけ");

  for (const [name, list, [p, c], want] of [
    ["親に親がある", [{ n: 1 }, { n: 2, parent: 1 }, { n: 3, parent: 2 }], [2, 3], null],
    ["子が子を持つ", [{ n: 5 }, { n: 6, parent: 5 }, { n: 7, parent: 6 }], [5, 6], null],
    ["正しい親子は外さず、親は子を待つ", [{ n: 1, status: "未着手" }, { n: 2, parent: 1, status: "保留", body: CHILD }], [1, 2], 1]]) {
    const g = world(list);
    await g.send(ev.sub(p, c));
    assert.equal(g.at(c).parent, want, name);
    if (!want) assert.match(head(g.at(c)), /^孫は作れないので/, name);
    else assert.equal(g.at(p).status, "未着手", name);
  }
});

test("tasks#824 レビューの直し: 印は指した行に・重複も見送り側・古い問いもさかのぼる・閉じた親の子は振り出さない・見送りで閉じたら PR も閉じる", async () => {
  const same = world([{ n: 1, status: "未着手", body: "- [ ] 動く\n  - 子: #2\n- [ ] 動く\n  - 子: #3\n" }, { n: 2, parent: 1, status: "保留", body: CHILD },
    { n: 3, parent: 1, status: "完了", state: "CLOSED", reason: "COMPLETED", body: CHILD }]);
  await same.send(ev.issue(3, "closed"));
  assert.equal(same.at(1).body, "- [ ] 動く\n  - 子: #2\n- [x] 動く\n  - 子: #3\n", "1行目の文が同じでも、閉じた子の行にだけ印");

  const dup = world([{ n: 1, status: "未着手", body: "- [ ] a\n  - 子: #2\n" }, { n: 2, parent: 1, status: "完了", state: "CLOSED", reason: "DUPLICATE", body: CHILD }]);
  await dup.send(ev.issue(2, "closed"));
  assert.deepEqual([dup.at(1).status, head(dup.at(1))], ["回答待ち", "## 問い（判断）"], "重複で閉じた子も、続けるかを問う");

  const old = world([{ n: 6, status: "未着手", blockedBy: [7], comments: [askDropped([7], config.questionTemplate), `## 回答\n**${droppedQuestion([7])}**\n\n回答: 続ける`,
    ...Array.from({ length: 45 }, (_, k) => `メモ ${k}`)] }, { n: 7, status: "完了", state: "CLOSED", reason: "NOT_PLANNED" }]);
  await old.send(ev.comment(6));
  assert.deepEqual([asked(old.at(6)), old.titles()], [1, ["#6 作る"]], "最近の40件より前に答えた問いも見つけ、問い直さない");

  const gone = world([{ n: 1, status: "完了", state: "CLOSED", reason: "COMPLETED", body: "- [x] a\n" }, { n: 2, parent: 1, status: "未着手", body: CHILD }]);
  await gone.send(ev.schedule());
  assert.deepEqual(gone.titles(), [], "親が閉じた子は、決め直す前でも振り出さない");

  const pr = world([{ n: 1, status: "完了", state: "CLOSED", reason: "NOT_PLANNED" }, { n: 2, parent: 1, status: "検証待ち", body: CHILD, pr: { draft: false, checks: "SUCCESS" } }]);
  await pr.send(ev.issue(1, "closed"));
  assert.deepEqual([pr.at(2).state, pr.at(2).reason, pr.at(2).pr.state], ["CLOSED", "NOT_PLANNED", "CLOSED"], "見送りで閉じた子の開いた PR も閉じる");
});

test("tasks#824 親子を外したら親は待ちをやめ、子を開き直したら親はまた待つ", async () => {
  const w = world([{ n: 1, status: "未着手", body: "- [ ] a\n" }, { n: 2, status: "保留", body: CHILD }]);
  await w.send(ev.sub(1, 2, "sub_issue_removed"));
  assert.deepEqual(w.titles(), ["#1 作る"], "外された子を待たない");
  const x = world([{ n: 1, status: "未着手", body: "- [x] a\n  - 子: #2\n- [ ] 見た目\n  - 確かめる: ユーザー\n" }, { n: 2, parent: 1, status: "完了", body: CHILD }]);
  await x.send(ev.issue(2, "reopened"));
  assert.deepEqual([x.at(1).status, asked(x.at(1)), x.titles()], ["未着手", 0, ["#2 作る"]], "開き直した子を待ち、親の確かめを問わない");
});

test("tasks#824 記法: 条件はチェックの行から字下げした続きまで。「- 確かめる:」「- 子:」だけが属性で、文の中の括弧や小項目は文の続き", () => {
  assert.deepEqual(conditions("- [ ] 道を押すと値が出る（区間の境目を含む）\n  境目では両側の値\n  - 夜間も含む\n  - 子: #12\n- [x] 済んだ\n- [ ] 見た目（色）\n\n  - 確かめる: ユーザー\n説明の段落\n"), [
    { index: 0, text: "道を押すと値が出る（区間の境目を含む） 境目では両側の値 - 夜間も含む", done: false, verify: "Claude", child: 12 },
    { index: 4, text: "済んだ", done: true, verify: "Claude", child: null },
    { index: 5, text: "見た目（色）", done: false, verify: "ユーザー", child: null }], "続きの間の空行のあとの属性も、同じ条件の属性");
});

test("K6・受け箱・状況の更新: 止めたら振り出さず理由を出す。処理が落ちても出来事を失わず、一時の失敗はやり直し、直らない失敗はすぐ諦めて出す", async () => {
  for (const [name, stop] of [["担当のワークフローが無効", { workflow: "disabled_manually" }], ["利用の上限で止まった直後",
    { last: [{ id: 5, conclusion: "failure", updated_at: new Date().toISOString() }], steps: [{ name: config.quotaStep, conclusion: "failure" }] }]]) {
    const off = world([{ n: 1, status: "未着手" }], stop);
    await off.send(ev.schedule());
    assert.deepEqual([off.titles(), off.updates.map((u) => u.status)], [[], ["AT_RISK"]], name);
  }
  const w = world([{ n: 1, status: "未着手", body: "- [x] 作る\n" }, { n: 2, status: "未着手", body: "- [x] 作る\n" }]);
  w.fail = Object.assign(new Error("GitHub が 502"), { transient: true });
  assert.ok((await w.send(ev.comment(1))) > Date.now(), "一時の失敗は、間をあけて起こす時刻を返す");
  w.fail = null;
  assert.ok((await w.send(ev.comment(2))) > Date.now(), "やり直しを待つ出来事がある間は、その時刻を返す");
  assert.deepEqual([w.at(1).status, w.at(2).status], ["未着手", "完了"], "待っている出来事があっても、後ろの出来事は先に進む");
  assert.equal(await w.inbox.drain(config.retries, Date.now() + 3600e3), null);
  assert.equal(w.at(1).status, "完了", "やり直しで処理した");
  w.fail = new Error("GitHub が 404");
  assert.equal(await w.send(ev.comment(1)), null, "やり直しても直らない失敗は、すぐ諦める");
  w.fail = null;
  await w.send(ev.schedule());
  assert.deepEqual([w.updates.at(-1).status, w.updates.at(-1).body.includes("404")], ["OFF_TRACK", true]);
  await w.send(ev.schedule());
  assert.equal(w.updates.at(-1).status, "ON_TRACK", "G8 出したら消し、戻ったら On track を書く");
});

test("tasks#307・K3・G4・G7: 本文の印の間・形に合わない問い・ボードの移動・着手可能日時の形", async () => {
  const w = world([{ n: 1, status: "未着手", body: "<!-- flow-gate -->\nメモ\n<!-- /flow-gate -->\n\n- [ ] 作る\n" },
    { n: 2, status: "回答待ち", comments: ["## 問い（判断）\n形に合わない"] }, { n: 3, status: "未着手", start: "来週" }]);
  await w.send(ev.issue(1, "edited"));
  assert.deepEqual([w.at(1).body.startsWith("メモ\n"), w.at(1).comments.length], [true, 1], "G3 印の間の見知らぬ行は、消さずに印の外の先頭へ出してコメントで知らせる");
  await w.send(ev.comment(2, config.claude));
  assert.match(head(w.at(2)), /形に合わないので/);
  await w.send(ev.issue(3, "edited"));
  assert.deepEqual([/着手可能日時「来週」/.test(head(w.at(3))), w.titles().includes("#3 作る")], [true, false], "G7 形の合わない着手可能日時は知らせ、まだ先と読んで振り出さない");
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
  const w = world([{ n: 1, status: "回答待ち", body: CONFIRM, comments: [ASKED("確かめ"), done] }]);
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).state, w.at(1).status, w.titles()], ["OPEN", "進行中", ["#1 作る"]], "#724: 完了にしても文があれば閉じず、作る担当が読む");
  Object.assign(w.at(1), { body: `${CONFIRM}- [ ] 距離のバーを候補数の横へ置く\n`, pr: { draft: true, checks: "PENDING" } }); // 担当が読んで条件に足し、作った
  w.at(1).comments.push(END(2));
  await w.send(ev.run(w.run(1), "completed"));
  assert.deepEqual([w.at(1).body.includes("- [x] 見た目"), w.at(1).state, w.at(1).status, head(w.at(1))], [true, "OPEN", "CI待ち", `${APPLIED}（完了）。`],
    "読んだあとに答え（完了にする）を当てて確かめた行に印を付け、当てたことを知らせる。足した条件が残るので閉じない");
  await w.send(ev.comment(1, config.claude));
  assert.equal(w.at(1).comments.filter((c) => c.startsWith(APPLIED)).length, 1, "答えは一度だけ当てる");

  const drop = world([{ n: 2, status: "回答待ち", author: config.claude, type: "要望",
    comments: [ASKED("採否"), "## 回答\n**このタスクに着手しますか？**\n\n回答: 見送る\n\n代わりにパネル全体を2列にしたい"] }]);
  await drop.send(ev.comment(2));
  assert.deepEqual([drop.at(2).state, drop.at(2).status], ["OPEN", "進行中"], "見送るでも文があれば、閉じる前に作る担当が読む");
  drop.at(2).comments.push(END(2));
  await drop.send(ev.run(drop.run(2), "completed"));
  assert.deepEqual([drop.at(2).state, drop.at(2).reason, head(drop.at(2))], ["CLOSED", "NOT_PLANNED", `${APPLIED}（見送り）。`], "読んだあとに見送りで閉じる");

  const late = world([{ n: 3, status: "完了", state: "CLOSED", reason: "COMPLETED", body: "- [x] 作る\n", closedAt: T(0.5), comments: [END(0), "ここも直して"], by: [undefined, config.user] }]);
  await late.send(ev.comment(3));
  assert.deepEqual([late.at(3).state, late.at(3).status], ["OPEN", "進行中"], "閉じたあとのコメントは、開き直して作る担当が読む");
  late.at(3).comments.push(END(2));
  await late.send(ev.run(late.run(3), "completed"));
  assert.deepEqual([late.at(3).state, late.at(3).reason], ["CLOSED", "COMPLETED"], "読んで条件が全部済んでいれば、完成で閉じ直す");

  const closing = world([{ n: 4, status: "未着手", state: "CLOSED", reason: "NOT_PLANNED", comments: ["やめる"], by: [config.user] }]);
  await closing.send(ev.issue(4, "closed"));
  assert.equal(closing.at(4).state, "CLOSED", "閉じるときに一緒に書いた文は、閉じる決定の一部（開き直さない）");

  const mid = world([{ n: 5, status: "未着手" }]);
  await mid.send(ev.schedule());
  const run = mid.run(5);
  mid.at(5).comments.push("途中で書いた");
  mid.at(5).by[0] = config.user;
  mid.at(5).comments.push(END(0)); // 担当は書かれる前に読み始めた
  await mid.send(ev.run(run, "completed"));
  assert.deepEqual([mid.at(5).status, mid.titles()], ["進行中", ["#5 作る", "#5 作る"]], "担当が読み始めたあとに書いた文は、次の担当が読む");

  const dialog = world([{ n: 6, status: "回答待ち", board: "dialog", type: config.dialogType, comments: [QUESTION, ANSWER("回答: 保留する\n\n来週にする")] }]);
  await dialog.send(ev.comment(6));
  assert.deepEqual([dialog.at(6).status, dialog.titles()], ["未着手", []], "対話作業: 文があれば開発機のセッションの番（振り出さない）");
  dialog.at(6).comments.push("来週に回すと読んだ");
  await dialog.send(ev.comment(6, config.claude));
  assert.deepEqual([dialog.at(6).status, head(dialog.at(6))], ["保留", `${APPLIED}（保留）。`], "対話作業: Claude が書いたら読んだとして、答えを当てる");
});

test("回答フォーム（R10〜R12・決め2・合意したモック）: 種類ごとに要るものだけを出し、次のステータスは出さない。送った答えでゲートが決め直す", async () => {
  const w = world([{ n: 1, status: "CI待ち", body: CONFIRM, pr: { state: "MERGED", merged: true, mergeChecks: "SUCCESS", sha: "m1" } },
    { n: 2, author: config.claude, type: "要望", board: null }, { n: 3, status: "未着手" }, { n: 4, status: "回答待ち", comments: [QUESTION] },
    { n: 5, status: "回答待ち", comments: ["### 作る担当の終わり\n担当の最後の発言",ASKED("イレギュラー")] }]);
  connect(w);
  await w.send(ev.ci(config.base, "m1")); // 確かめの問い
  await w.send(ev.issue(2, "opened", config.claude)); // 採否の問い
  const check = await (await open(1)).text();
  for (const text of ["見た目", "完了にする（上の全部）", "書くこと", "確認", "戻る", "送信"]) assert.ok(check.includes(text), `確かめ: ${text}`);
  for (const text of ["次のステータス", "問題なし", "問題あり"]) assert.ok(!check.includes(text), `確かめ: ${text} は出さない`);
  assert.match(check, /<textarea name="note" rows="4"/, "書く欄は1つで4行");
  const adopt = await (await open(2)).text();
  for (const text of ["着手する", "保留する", "見送る"]) assert.ok(adopt.includes(text), `採否: ${text}`);
  assert.ok((await (await open(4)).text()).includes("どれでもない（書く欄に書く）"), "判断: 案と、どれでもない（書く欄に書く）");
  const irregular = await (await open(5)).text();
  assert.ok(irregular.indexOf("担当の最後の発言") < irregular.indexOf("判断材料"), "イレギュラー: 何が起きたか（担当の終わり）を判断材料より上に出す");
  for (const text of ["やり直す", "保留する", "見送る"]) assert.ok(irregular.includes(text), `イレギュラー: ${text}`);
  assert.equal((await open(3)).status, 404, "答えていない問いが無い");
  assert.match((await answer(1, { question: "前の問い" })).error, /問いが新しくなっています/);
  assert.match((await answer(1, {})).error, /完了にするか、直してほしいことを書いてください/, "確かめは、完了にするか書くかのどちらかが要る");
  assert.match((await answer(4, { choice: "どれでもない（書く欄に書く）" })).error, /書く欄に書いてください/);
  await answer(1, { note: "崩れる" });
  assert.match(w.at(1).comments.at(-1), /\n\n崩れる$/, "書いた文は形を付けずにそのまま置く");
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).state, w.at(1).status, w.titles().filter((t) => t.startsWith("#1"))], ["OPEN", "進行中", ["#1 作る"]], "決め2 書いた文は作る担当が読む（完成にしない）");
  await answer(2, { choice: "見送る", label: ["急ぎ"] });
  await w.send(ev.comment(2));
  assert.deepEqual([w.at(2).state, w.at(2).reason, w.at(2).labels], ["CLOSED", "NOT_PLANNED", ["急ぎ"]], "採否の見送るで閉じる。ラベルの付け外しも送る");
});
