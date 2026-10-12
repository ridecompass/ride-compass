// 回答フォーム（Cloudflare Access の内側の Worker）。見た目と流れはユーザーと合意したモック: スマホの幅で1列・エリアは「回答内容」（案と書く欄）と
// 「この issue を」（次遷移のボタンの横並び）の2つで、互いに干渉しない・「確認」で入力を固めて戻る／送信を横に並べ・送ったあとは結果と「GitHub に
// 戻る」だけ。欄は問いの回答内容の節だけから導き、ラベルで分けない（.claude/skills/ask/SKILL.md「問い」）。推奨も次遷移も最初から選んだ状態にしない。
// 答えはユーザーの名義（env.FORM_TOKEN）でコメントに書き、ラベルの付け外しも同じ名義で、同じ1回の要求で書く。ゲートは次遷移だけを読み、
// 書いた文があれば Claude が読んでから当てる。
import { GitHub } from "./github.js";
import { byName, jstText } from "./facts.js";
import { NEXT, answerBody, answerProblem, answerUrl, askerOf, isQuestion, isQuestionLabel, latestQuestion, nextsOf } from "./questions.js";

const RECENT = 5; // 材料に載せる最近のコメント（上に出した問いのコメントは数えない）
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const SCRIPT = `<script>
const f = document.querySelector("form"), err = document.getElementById("err");
document.getElementById("go")?.addEventListener("click", () => f.classList.add("lock"));
document.getElementById("back")?.addEventListener("click", () => f.classList.remove("lock"));
f?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!f.classList.contains("lock")) return;
  f.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const j = await (await fetch(location.href, { method: "POST", body: new FormData(f) })).json();
  if (j.error) { err.textContent = j.error; f.classList.remove("lock"); f.querySelectorAll("button").forEach((b) => (b.disabled = false)); return; }
  const p = (text, className = "") => Object.assign(document.createElement("p"), { textContent: text, className });
  // 先にタブを閉じる（移ったあとではこのページが無く、閉じる処理が動かない）。閉じられない開き方なら issue へ移る。
  const back = Object.assign(document.createElement("button"), { textContent: "GitHub に戻る", className: "sub" });
  back.addEventListener("click", () => (window.close(), setTimeout(() => location.replace(j.url), 300)));
  document.body.replaceChildren(p("受け付けました（" + j.label + "）。"), back, p("押すとこのタブを閉じる。閉じられない開き方のときは issue へ移る。", "note"));
});
</script>`;

const page = (inner, status = 200) => new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>回答</title><style>body{font:14px/1.6 system-ui,sans-serif;max-width:34rem;margin:.75rem auto;padding:0 16px}p{margin:0 0 .5rem}
.num,.sec,.note,summary.s{font-size:13px;opacity:.7}.num{font-size:12px;margin:0}.title{font-weight:500;margin:0 0 6px}.sec{margin:14px 0 6px}
details{border-bottom:1px solid #8884;padding:6px 0;overflow-wrap:anywhere}details>div{max-height:40vh;overflow:auto;font-size:13px;margin-top:6px}
.opt{display:flex;gap:8px;align-items:flex-start;padding:7px 0;border-bottom:1px solid #8884;overflow-wrap:anywhere}.item{padding:8px 0;border-bottom:1px solid #8884}
.item>p{font-size:13px;margin:0 0 6px}textarea,input[type=text]{width:100%;box-sizing:border-box;font:inherit;margin-top:8px}
.seg{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;border:1px solid #8888;border-radius:8px;overflow:hidden}
.seg label{text-align:center;font-size:13px;padding:8px 0}.seg label+label{border-left:1px solid #8888}.seg input{position:absolute;opacity:0;pointer-events:none}
.seg label:has(input:checked){background:#1f6feb22;color:#1f6feb}.labels{border:0;margin-top:6px}.labels>div{display:flex;flex-wrap:wrap;gap:10px}
#err{font-size:13px;color:#d1242f;min-height:1em;margin:8px 0 0}button{display:block;width:100%;padding:8px;margin-top:4px;border-radius:8px;font:inherit}
.sub{background:transparent;color:inherit;border:1px solid #8888}.main{background:#1f6feb;color:#fff;border:0}.row{display:none;gap:8px}.row button{flex:1}
.lock .inp{pointer-events:none;opacity:.55}.lock #go{display:none}.lock .row{display:flex}
.items{margin:0;padding-left:1.1em;font-size:13px}.why{display:block;font-size:12px;opacity:.75}.rec{font-size:11px;color:#1a7f37;margin-left:6px}
.hint{font-size:12px;opacity:.7;margin:4px 0 0}</style></head><body>${inner}${SCRIPT}</body></html>`,
{ status, headers: { "content-type": "text/html; charset=utf-8" } });

async function read(gh, config, number) {
  const { owner: o, name: n } = config.repos.tasks;
  const r = await gh.gql(`query($o:String!,$n:String!,$i:Int!){repository(owner:$o,name:$n){labels(first:100){nodes{id name}}
    issue(number:$i){id title url bodyHTML labels(first:50){nodes{name}} comments(last:40){nodes{body bodyHTML url createdAt author{login}}}}}}`, { o, n, i: number });
  const { issue, labels } = r.repository;
  const comments = issue.comments.nodes;
  const asked = comments.findLast((c) => isQuestion(c.body));
  // ゲートと同じく、形に合わない問いと、ラベルの出す者でない者が書いた問いは、問いとして読まない。
  const question = latestQuestion(comments.map((c) => c.body), config.questionForms, asked && askerOf(config, asked.author?.login));
  // 問いのラベルはゲートだけが付け外しするので、ラベルの欄に出さず、送っても変えない。
  return { issue, comments, asked, question, ids: byName(labels),
    all: labels.nodes.map((l) => l.name).filter((n) => !isQuestionLabel(n)), have: issue.labels.nodes.map((l) => l.name) };
}

const seg = (name, values) => `<div class="seg">${values.map(([v, text]) => `<label><input type="radio" name="${name}" value="${esc(v)}">${esc(text)}</label>`).join("")}</div>`;
const box = (type, name, value, text, extra = "", cls = "opt") => `<label class="${cls}"><input type="${type}" name="${name}" value="${esc(value)}"${extra}><span>${esc(text)}</span></label>`;
const fold = (title, inner, open = false) => (inner ? `<details${open ? " open" : ""}><summary>${title}</summary><div>${inner}</div></details>` : "");

// 回答内容（案があれば1行ずつの丸に推奨の印と理由を添え、確かめること・済ませることは一覧）と書く欄、「この issue を」の次遷移のボタン。行は隠しの欄でも
// 送り、開いたあとに問いが変わっていないかを照らす。
const why = (r) => r.attrs.map(([, v]) => `<span class="why">${esc(v)}</span>`).join("");
function answerFields(q) {
  const plan = q.header === "### 案";
  const rows = q.rows.map((r, i) => `<input type="hidden" name="item${i}" value="${esc(r.text)}">` + (plan
    ? `<label class="opt"><input type="radio" name="plan" value="${esc(r.text)}"><span>${esc(r.text)}${r.attrs.some(([n]) => n === "推奨") ? '<b class="rec">推奨</b>' : ""}${why(r)}</span></label>`
    : `<li>${esc(r.text)}${why(r)}</li>`)).join("");
  return `<p class="sec">回答内容</p>${plan || !rows ? rows : `<ul class="items">${rows}</ul>`}
<textarea name="note" rows="4" placeholder="Claude に伝えること（任意）" aria-label="Claude に伝えること"></textarea>
<p class="sec">この issue を</p>${seg("next", nextsOf(q).map((n) => [n, NEXT[n]]))}`;
}

async function submit(gh, env, config, number, form) {
  const { issue, question: q, ids, all, have } = await read(gh, config, number);
  if (!q || q.answer) return { error: "答えていない問いがありません。" };
  if (form.get("question") !== q.text) return { error: "問いが新しくなっています。開き直してください。" };
  // 行は開いたときの文で送られる。今の問いの行と違えば、開いたあとに問いが変わったので開き直してもらう。
  const items = [...form.keys()].filter((k) => /^item\d+$/.test(k)).map((k) => form.get(k));
  if (JSON.stringify(items) !== JSON.stringify(q.rows.map((r) => r.text))) return { error: "問いが新しくなっています。開き直してください。" };
  const answer = { next: form.get("next"), plan: form.get("plan"), text: String(form.get("note") ?? "").trim() };
  const problem = answerProblem(q, answer);
  if (problem) return { error: problem };
  const chosen = form.getAll("label").filter((n) => all.includes(n));
  const added = chosen.filter((n) => !have.includes(n));
  const removed = have.filter((n) => all.includes(n) && !chosen.includes(n));
  const labels = [...added.map((n) => `+${n}`), ...removed.map((n) => `−${n}`)].join(" ");
  const v = { i: issue.id, b: answerBody(q, { ...answer, labels }), a: added.map((n) => ids[n]), r: removed.map((n) => ids[n]) };
  await new GitHub(env.FORM_TOKEN).gql(`mutation($i:ID!,$b:String!,$a:[ID!]!,$r:[ID!]!){c:addComment(input:{subjectId:$i,body:$b}){clientMutationId}
    ${added.length ? "a:addLabelsToLabelable(input:{labelableId:$i,labelIds:$a}){clientMutationId}" : ""}
    ${removed.length ? "r:removeLabelsFromLabelable(input:{labelableId:$i,labelIds:$r}){clientMutationId}" : ""}}`, v);
  return { url: issue.url, label: NEXT[answer.next] };
}

export async function answerForm(request, env, config) {
  const number = Number(new URL(request.url).searchParams.get("issue"));
  const gh = await GitHub.app(env, config.installation);
  if (request.method === "POST") return Response.json(await submit(gh, env, config, number, await request.formData()));
  const { issue, comments, asked, question: q, all, have } = await read(gh, config, number);
  if (!q || q.answer) return page(`<p>#${number} に、答えていない問いはありません。</p>`, 404);
  const recent = comments.filter((c) => c !== asked).slice(-RECENT).reverse()
    .map((c) => `<p class="note"><a href="${esc(c.url)}">${esc(c.author?.login ?? "ghost")} ・ ${jstText(Date.parse(c.createdAt))}</a></p>${c.bodyHTML}`).join("");
  // 判断材料と本文は、読んだときに GitHub が描いた HTML を使う（判断材料は問いのコメントの <details>、本文は頭の回答のボタンを除く）。
  const material = /<details[\s\S]*<\/details>/.exec(asked.bodyHTML)?.[0].replace("<details", "<details open") ?? "";
  const button = issue.bodyHTML.indexOf(`href="${answerUrl(config, number)}"`);
  const body = button < 0 ? issue.bodyHTML : issue.bodyHTML.slice(issue.bodyHTML.indexOf("</p>", button) + "</p>".length);
  return page(`<p class="num">#${number}</p><p class="title">${esc(issue.title)}</p><p>${esc(q.text)}</p>
${material}${fold("本文", body)}${fold("最近のコメント", recent)}
<form><input type="hidden" name="question" value="${esc(q.text)}"><div class="inp">${answerFields(q)}
<p class="hint">書けば Claude が読んでから進みます。</p>
<details class="labels"><summary class="s">ラベル（任意）</summary><div>${all.map((n) => box("checkbox", "label", n, n, have.includes(n) ? " checked" : "", "")).join("")}</div></details>
</div><p id="err"></p><button type="button" id="go" class="sub">確認</button><div class="row"><button type="button" id="back" class="sub">戻る</button><button class="main">送信</button></div></form>`);
}
