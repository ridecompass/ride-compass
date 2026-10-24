// タスクの事実を読む（src/decide.js: decide が受ける形）。置き場の issue・書くのに要る ID（種類・ラベル）・コードのリポジトリの作業ブランチの PR と
// 検査を GraphQL の1回で、担当の実行は Actions の実行の一覧から読む。ゲートは issue の情報を持たない（持ち主は GitHub）。見回りの一覧も同じ読み方を使う。
import { originOf } from "./family.js";
import { FIELDS, START_FORM, valuesOf } from "./fields.js";
import { pages } from "./github.js";
import { APPLIED, answerText, askerOf, conditions, droppedQuestion, isAnswer, isQuestion, latestQuestion, norm, questionHead, readProblems, remaining, unboundSteps } from "./questions.js";

// 着手可能日時の形の合わない値は受け入れず（badStart はその値。ゲートが知らせる）、待つと決めた意図を守ってまだ先と読む。
const jst = (text) => (START_FORM.test(text) ? new Date(`${text.replace(" ", "T")}${text.includes(":") ? "" : "T00:00"}:00+09:00`) : null);
// 対話作業か。種類は作るとき（最初に付いた種類）で決まり、あとから境目をまたいで変えても変わらない（types は今より前の種類の古い順）。
const dialogOf = (config, types, type) => [...types, type].find(Boolean) === config.dialogType;
// 矢印1本でつながる issue（前提・子・親）の読み方。1件を決め直すときも、振り出しの一覧も同じ（親の本文は、1件を決め直すときだけ要る）。
export const relationsOf = (body = false) => `blockedBy(first:20){nodes{number state stateReason issueType{name} updatedAt}} subIssues(first:50){nodes{number state stateReason}}
 parent{number state stateReason ${body ? "body" : ""} labels(first:20){nodes{name}} ${FIELDS}}`;
// 完成でなく閉じた（見送り・重複）相手は、その結果を当てにできないので、続けるかを問う側に数える。
const dropped = (x) => x.state === "CLOSED" && ["NOT_PLANNED", "DUPLICATE"].includes(x.stateReason);
// issue の欄とラベルから、欄と待ちを組む（1件を決め直すときも、振り出しの一覧も同じ）。子（親を持つ issue）は、優先度・着手可能日時・
// 急ぎ・保留を自分では持たず、親の値を見る（親が閉じていれば、閉じるのを待つ子なので振り出さない）。待つ相手は前提と子で、どちらも同じに扱う。
export function taskOf(config, issue, now = new Date()) {
  const f = config.fields;
  const own = valuesOf(issue);
  const parent = issue.parent;
  const from = parent ? valuesOf(parent) : own;
  const text = from[f.start.name]?.trim();
  const start = jst(text);
  const mine = own[f.start.name]?.trim();
  const waits = [...issue.blockedBy.nodes, ...issue.subIssues.nodes];
  // 開発機の対話のセッションしか進めない前提は、閉じ忘れると黙って待ち続けるので、長く動いていなければユーザーに知らせる（src/decide.js: notice）。
  const idle = issue.blockedBy.nodes.filter((b) => b.state === "OPEN" && b.issueType?.name === config.dialogType
    && now - Date.parse(b.updatedAt) > config.dialogIdleHours * 3600e3).map((b) => b.number);
  const names = (i) => i.labels.nodes.map((l) => l.name);
  const labels = names(issue);
  return { status: own[f.status.name], run: own[f.run.name], priority: from[f.priority.name], type: issue.issueType?.name ?? null,
    open: issue.state === "OPEN", blocked: waits.some((w) => w.state === "OPEN"), dropped: waits.filter(dropped).map((w) => w.number), idle,
    future: Boolean(text) && (!start || start > now), badStart: mine && !jst(mine) ? mine : null,
    urgent: names(parent ?? issue).includes(config.urgentLabel), held: Boolean(parent) && (parent.state === "CLOSED" || from[f.status.name] === "保留"),
    labels, dev: labels.includes(config.devLabel), dialog: issue.issueType?.name === config.dialogType, // 1件を決め直すときは、作ったときの種類で読み直す
    assignees: issue.assignees.nodes.map((a) => a.login) };
}
export const jstText = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " "); // 日本時間の「YYYY-MM-DD HH:MM」
// 担当の実行の名前「#<番号> <種類> <振り出しの識別子>」（claude-task.yml の run-name。手で起こした実行は識別子が無い）。
export function runOf(title) {
  const [, number, kind, key] = /^#(\d+) (\S+)(?: (\S+))?/.exec(title) ?? [];
  return number ? { number: Number(number), kind, key } : null;
}
// master のコミットの件名「tasks#<番号>: …」（docs/conventions/flow.md「コミット」。Pull Request の題名がそのまま件名になり、push で動いた
// 実行の名前にもなる）の issue の番号。番号の無い件名はタスクでないコミットで、null。
export const subjectTask = (subject) => Number(/^tasks#(\d+): /.exec(subject)?.[1]) || null;
// 担当のワークフロー（config.workflow）の近ごろの実行（新しい順に100本）。動いているか・枠が埋まっているかは、出来事1件につき1回ここから読む。
// status は GitHub の値のまま持つ（欄「実行の status」へ写す）。
export async function recentRuns(gh, config) {
  const { workflow_runs: runs } = await gh.rest("GET", `/repos/${config.code}/actions/workflows/${config.workflow}/runs?per_page=100&exclude_pull_requests=true`);
  return runs.map((r) => ({ ...runOf(r.display_title), id: r.id, status: r.status, active: r.status !== "completed", conclusion: r.conclusion,
    created: Date.parse(r.created_at), updated: Date.parse(r.updated_at) })).filter((r) => r.number);
}

// 検査は、コミットに付いた検査のワークフロー（flow.config.json: checks.workflow）の実行（check suite）のうち、最も新しく始まった1本を読む。
// 説明文を書き直すと同じコミットで打ち直し、前の実行は取り消されて残る。ほかのワークフロー（担当・必須でない検査）の実行は数えない。
const SUITES = "checkSuites(last:30){nodes{status conclusion createdAt workflowRun{file{path}}}}";
const checkRuns = (config, commit) => (commit?.checkSuites.nodes ?? []).filter((s) => s.workflowRun?.file?.path.endsWith(`/${config.checks.workflow}`));
const query = () => `query($to:String!,$tn:String!,$n:Int!,$co:String!,$cn:String!,$head:String!){
 t:repository(owner:$to,name:$tn){issueTypes(first:20){nodes{id name}} labels(first:100){nodes{id name}}
  issue(number:$n){id state stateReason closedAt body author{login} issueType{name} assignees(first:10){nodes{login}} labels(first:20){nodes{name}}
  comments(last:40){totalCount nodes{body createdAt author{login}}} ${FIELDS} ${relationsOf(true)} blocking(first:20){nodes{number state}}
  timelineItems(first:50,itemTypes:[ISSUE_TYPE_CHANGED_EVENT]){nodes{...on IssueTypeChangedEvent{prevIssueType{name} issueType{name}}}}}}
 c:repository(owner:$co,name:$cn){pullRequests(headRefName:$head,first:5,orderBy:{field:CREATED_AT,direction:DESC}){nodes{
  id state isDraft mergeable merged createdAt mergedAt mergeCommit{oid ${SUITES}} commits(last:1){nodes{commit{committedDate ${SUITES}}}}
  timelineItems(last:1,itemTypes:[CONVERT_TO_DRAFT_EVENT]){nodes{...on ConvertToDraftEvent{createdAt}}}}}}}`;

// 合格の結論（GitHub が必須の検査の合格に数えるもの: 成功・スキップ・中立）。
const PASSED = ["SUCCESS", "SKIPPED", "NEUTRAL"];
// コミットの検査。stage は最も新しい検査の実行の status（実行が無ければ null）、passed はその実行が終わって合格したか。実行の結論は
// Pull Request では結論のジョブ（ci-ok）と同じで、master ではデプロイも含む（本番に出てから合格にする）。
// cancelled は、その実行が取り消されたか（master では、後の push が待ちを置き換えた。.github/workflows/ci.yml の concurrency）。missed は、その実行が
// 合格せずに終わったか（落ちた・取り消された）。
function checksOf(config, commit) {
  const last = checkRuns(config, commit).reduce((a, s) => (a && a.createdAt > s.createdAt ? a : s), null);
  const passed = PASSED.includes(last?.conclusion);
  return { stage: last?.status ?? null, passed, cancelled: last?.conclusion === "CANCELLED", missed: last?.status === "COMPLETED" && !passed };
}
// master の検査の実行が合格せずに終わった（落ちた・取り消された）コミットの変更は、後の master の実行が検査とデプロイの判定に入れる（ci.yml の
// changes ジョブは、first-parent の祖先のうち検査が通った一番近いコミットと比べる）。その実行は、first-parent の子の側へ辿って、検査の実行が
// 取り消されていない一番近いコミットのもの。FOLLOW はその辿る数で、取り消しが続くのは待ちが重なった間だけなので、辿り切れなければ代わりの実行は無いと読む。
const FOLLOW = 10;
// oid のコミットの代わりに検査を持つ後の master の実行（checksOf の形）。無ければ null。
async function coveringChecks(gh, config, oid) {
  const { owner, name } = config.repos.code;
  // 比べる API は、oid に無く master にあるコミットを古い順に返す（GitHub の公式の文書「Compare two commits」）ので、子の側の近いものが先のページにある。
  const { commits } = await gh.rest("GET", `/repos/${config.code}/compare/${oid}...${config.base}?per_page=100`);
  const chain = [];
  for (let at = oid; chain.length < FOLLOW;) {
    const child = commits.find((c) => c.parents[0]?.sha === at);
    if (!child) break;
    chain.push(at = child.sha);
  }
  if (!chain.length) return null;
  const { repository: r } = await gh.gql(`query($o:String!,$r:String!){repository(owner:$o,name:$r){${chain.map((sha, k) => `c${k}:object(oid:"${sha}"){...on Commit{${SUITES}}}`).join(" ")}}}`,
    { o: owner, r: name });
  const found = chain.map((_, k) => r[`c${k}`]).find((c) => checkRuns(config, c).length && !checksOf(config, c).cancelled);
  return found ? checksOf(config, found) : null;
}
// sha のコミットの master の実行が代わりに検査を持つ、first-parent の祖先のマージのコミットの issue の番号（上の coveringChecks の逆向き）。
export async function coveredTasks(gh, config, sha) {
  const { owner, name } = config.repos.code;
  const { repository: { object: o } } = await gh.gql(`query($o:String!,$r:String!,$s:GitObjectID!){repository(owner:$o,name:$r){object(oid:$s){...on Commit{
    history(first:${FOLLOW * 3}){nodes{oid messageHeadline parents(first:1){nodes{oid}} ${SUITES}}}}}}}`, { o: owner, r: name, s: sha });
  const by = new Map((o?.history.nodes ?? []).map((n) => [n.oid, n]));
  const up = (n) => by.get(n?.parents.nodes[0]?.oid);
  const numbers = [];
  for (let n = up(by.get(sha)); n && checksOf(config, n).missed && numbers.length < FOLLOW; n = up(n)) numbers.push(subjectTask(n.messageHeadline));
  return numbers.filter(Boolean);
}

// 置き場のオーナーと名前（GraphQL の $o・$r）。
const repo = ({ repos: { tasks } }) => ({ o: tasks.owner, r: tasks.name });
// issue の全部のコメントの本文（古い順）。
const allComments = async (gh, config, number) => (await Array.fromAsync(pages(gh, `query($o:String!,$r:String!,$n:Int!,$a:String){repository(owner:$o,name:$r){issue(number:$n){
  comments(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{body}}}}}`, { ...repo(config), n: number }, (d) => d.repository.issue.comments))).map((c) => norm(c.body));

// since より後に、ユーザーがステータスを変えたか開き直したか（時系列を、見つかるまでページを送って読む）。
async function movedSince(gh, config, number, since) {
  for await (const e of pages(gh, `query($o:String!,$r:String!,$n:Int!,$s:DateTime!,$a:String){repository(owner:$o,name:$r){issue(number:$n){
    timelineItems(since:$s,first:100,after:$a,itemTypes:[ISSUE_FIELD_ADDED_EVENT,ISSUE_FIELD_CHANGED_EVENT,REOPENED_EVENT]){pageInfo{hasNextPage endCursor} nodes{
     ...on IssueFieldAddedEvent{actor{login} issueField{...on IssueFieldSingleSelect{name}}} ...on IssueFieldChangedEvent{actor{login} issueField{...on IssueFieldSingleSelect{name}}}
     ...on ReopenedEvent{actor{login}}}}}}}`, { ...repo(config), n: number, s: since }, (d) => d.repository.issue.timelineItems))
    if (e.actor?.login === config.user && (!e.issueField || e.issueField.name === config.fields.status.name)) return true;
  return false;
}

// 担当の終わりのコメントの形（.github/claude-task/after.js が書き、ゲートと回答フォームが読む）。見出しの kind は担当の種類。
export const endHead = (kind) => `### ${kind}担当の終わり`;
export const END = /^### (\S+)担当の終わり/;
// 終わりのコメントの「読み始め」の行（担当の段が始まった時刻。それより前のユーザーの文を担当が読んでいる）。
export const readFromLine = (at) => `読み始め: ${at}`;
export const readFromOf = (body) => /^読み始め: (\S+)$/m.exec(body)?.[1] ?? null;
// 終わりのコメントの「読み始めの完了の条件」の塊（担当の段が始まったときの本文の完了の条件を、文とチェックだけの1行ずつで写す）。本文が
// 読めなければ読めなかったと書き、ゲートは約束が動いたと読まない。
const START = "読み始めの完了の条件:";
export const startBlock = (body) => (body ? [START, ...conditions(body).map((c) => `- [${c.done ? "x" : " "}] ${c.text}`)].join("\n") : `${START} 読めなかった`);
// 最後に終わった担当（種類・読み始めの時刻・読み始めの完了の条件）。終わりのあとに答えがあれば、その終わりは答えで扱ったので null。
function endedOf(nodes) {
  const k = nodes.findLastIndex((n) => END.test(norm(n.body)));
  if (k < 0 || nodes.slice(k + 1).some((n) => isAnswer(n.body))) return null;
  const body = norm(nodes[k].body);
  const at = body.indexOf(`\n${START}\n`);
  return { kind: END.exec(body)[1], from: readFromOf(body) ?? nodes[k].createdAt, before: at < 0 ? null : conditions(body.slice(at + START.length + 2)) };
}
// その実行で約束が動いたか: 読み始めより今のチェックが多いか、読み始めの行のうち今の本文に無い行が、全部移管先（子・兄弟・この issue を
// 指す issue）の条件にある。消えた行があるときだけ移管先を読む（要求1回）。読み始めの条件が無ければ動いていない。
async function movedOf(gh, config, number, ended, now) {
  const done = (list) => list.filter((c) => c.done).length;
  if (!ended.before) return false;
  if (done(now) > done(ended.before)) return true;
  const gone = ended.before.filter((c) => !now.some((x) => x.text === c.text));
  if (!gone.length) return false;
  const { repository: { issue: i } } = await gh.gql(`query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){
    subIssues(first:50){nodes{body}} parent{subIssues(first:50){nodes{body}}}
    timelineItems(last:50,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{...on CrossReferencedEvent{source{...on Issue{body}}}}}}}}`, { ...repo(config), n: number });
  const made = [...i.subIssues.nodes, ...(i.parent?.subIssues.nodes ?? []), ...i.timelineItems.nodes.map((x) => x.source).filter((x) => x?.body)]
    .flatMap((x) => conditions(x.body));
  return gone.every((c) => made.some((x) => x.text === c.text));
}

// GraphQL の一覧の名前から ID を引く表。
export const byName = (list) => Object.fromEntries(list.nodes.map((x) => [x.name, x.id]));

// runs は出来事1件につき1回読んだ担当の実行の一覧（recentRuns）。
export async function readFacts(gh, config, number, runs) {
  const { tasks, code } = config.repos;
  const { t, c } = await gh.gql(query(), { to: tasks.owner, tn: tasks.name, n: number, co: code.owner, cn: code.name, head: `${config.branchPrefix}${number}` });
  const i = t.issue;
  const held = runs.filter((r) => r.number === number && r.active).sort((a, b) => a.created - b.created); // 古い順（2本目からは二重の実行）
  const open = c.pullRequests.nodes.find((p) => p.state === "OPEN");
  const head = open?.commits.nodes.at(-1);
  const drafted = open?.timelineItems.nodes[0]?.createdAt;
  const merged = c.pullRequests.nodes.find((p) => p.merged); // 新しいものから並ぶ
  const nodes = i.comments.nodes;
  const comments = nodes.map((n) => norm(n.body)); // 最近のコメント（同じ知らせを重ねないためにも読む）
  const last = comments.at(-1);
  // ユーザーが書いた文（答えなら決まった形の行のほかの文）を、Claude が読んだか。担当は、終わりのコメントの「読み始め:」の時刻より前のコメントを
  // 読んでいる（前の形の終わりのコメントは書いた時刻）。対話作業とラベル「開発機で作業中」の issue は開発機の対話のセッションが読んでから書くので、Claude のコメントがあれば
  // それより前を読んでいる。閉じたあとの文だけを数える（閉じるときに一緒に書いた文は、閉じる決定の一部）。
  const at = (n) => Date.parse(n.createdAt);
  const by = (n, login) => n.author?.login === login;
  const types = i.timelineItems.nodes.map((e) => e.prevIssueType?.name ?? null); // 今より前の種類（古い順）
  const dialog = dialogOf(config, types, i.issueType?.name ?? null);
  const task = taskOf(config, i);
  const reads = nodes.filter((n) => by(n, config.claude) && (dialog || task.dev || END.test(norm(n.body))))
    .map((n) => Date.parse(readFromOf(norm(n.body)) ?? n.createdAt));
  const lastRead = Math.max(0, ...reads);
  const closedAt = Date.parse(i.closedAt) || 0;
  const said = (n) => (isAnswer(n.body) ? answerText(n.body) : norm(n.body).trim());
  const unread = nodes.some((n) => by(n, config.user) && said(n) && at(n) > lastRead && (i.state === "OPEN" || at(n) > closedAt));
  // 今の問いへの答えを、Claude が読んだか・ゲートが当てたか（書いた文のある答えは、読んだあとに一度だけ当てる）。
  const asked = nodes.findLastIndex((n) => isQuestion(n.body));
  const answer = asked < 0 ? null : nodes.slice(asked + 1).find((n) => isAnswer(n.body));
  const answerRead = Boolean(answer) && reads.some((x) => x > at(answer));
  const answerApplied = Boolean(answer) && nodes.some((n) => at(n) > at(answer) && norm(n.body).startsWith(APPLIED));
  // 今の問いは、ラベルの形に合い、ラベルの出す者が書いたものだけを読む。
  const asker = asked < 0 ? null : askerOf(config, nodes[asked].author?.login);
  const latest = latestQuestion(comments, config.questionForms, asker);
  const question = latest && { ...latest, at: at(nodes[asked]) };
  // 子は、親が閉じて開き直されないなら（要望が満たされた・やめた）生きていない。条件が残ったまま完成で閉じた親は、ゲートが開き直す。
  const p = i.parent;
  const dead = Boolean(p) && p.state === "CLOSED" && !(p.stateReason === "COMPLETED" && remaining(p.body).length);
  // 一度でも出した問いか。最近のコメントに無く、それより前のコメントがあれば、さかのぼって全部を読む（答えたあとに問い直さない）。
  let older = null;
  const ever = async (has) => comments.some(has) || (i.comments.totalCount > nodes.length && (older ??= await allComments(gh, config, number)).some(has));
  const asking = task.dropped.length ? droppedQuestion(task.dropped) : null;
  // 作業ブランチで次の持ち主へ渡した最後の時刻（検査が始まった・マージした・下書きへ戻した）。担当の実行の間か問いのあとにこれが動いて
  // いれば、状態が動いた（検査の出ない push は検査へ渡していない）。
  const handed = Math.max(0, ...c.pullRequests.nodes.flatMap((x) => [x.mergedAt, x.timelineItems.nodes[0]?.createdAt,
    ...checkRuns(config, x.commits.nodes[0].commit).map((s) => s.createdAt)]).map((t) => Date.parse(t) || 0));
  const conds = conditions(i.body);
  const ended = endedOf(nodes);
  // 読むのに要求の要る事実は、決め方が使うときだけ読む（src/decide.js: Need。src/gate.js: settle が読んで決め直す）:
  // superseded は、答えのあとにユーザーがステータスを変えたか開き直したか（その答えはユーザーの次の決定で置き換わり、当て直さない）。
  // adoptAsked・droppedAsked は、採否・続行の問いを一度でも出したか（最近のコメントに無く、それより前があれば全部を読む）。
  // ranMoved は、最後に終わった担当の実行で状態か約束が動いたか。covering は、マージのコミットの検査の実行が合格せずに終わったとき、代わりに検査を持つ
  // 後の master の実行（coveringChecks）。
  const later = { covering: () => coveringChecks(gh, config, merged.mergeCommit.oid), superseded: () => movedSince(gh, config, number, answer.createdAt), droppedAsked: () => ever((x) => x.includes(asking)),
    adoptAsked: () => ever((x) => x.startsWith(questionHead("採否"))), ranMoved: async () => handed > Date.parse(ended.from) || movedOf(gh, config, number, ended, conds) };
  return { ...task, later, author: i.author?.login, parent: p && { number: p.number }, origin: originOf(norm(i.body)), unread, answerRead, answerApplied, number,
    id: i.id, closedAs: i.stateReason, body: i.body, remaining: conds.filter((x) => !x.done), unbound: unboundSteps(i.body, number), question, dead, types, dialog,
    ids: { types: byName(t.issueTypes), labels: byName(t.labels) }, handed, ended: ended && { kind: ended.kind }, runs: held,
    // 閉じた・開き直したときに決め直す、矢印1本でつながる開いた issue（後・親・子）。
    near: [...i.blocking.nodes, ...(p ? [p] : []), ...i.subIssues.nodes].filter((x) => x.state === "OPEN").map((x) => x.number),
    merged: Boolean(merged), mergeChecks: checksOf(config, merged?.mergeCommit),
    badQuestion: last && isQuestion(last) ? readProblems(config.questionForms, last, asker) : [], comments,
    pr: open && { id: open.id, draft: open.isDraft, checks: checksOf(config, head.commit), backToDraft: Boolean(drafted && drafted > head.commit.committedDate),
      conflicting: open.mergeable === "CONFLICTING" } }; // GitHub が計算中（UNKNOWN）の間は、ぶつかりに数えない
}
