// 回答フォーム（Cloudflare Access の内側の Worker）。見た目と流れはユーザーと合意したモック:
// スマホの幅で1列・材料と選ぶ行は下の区切り線だけ・欄は「選ぶ1つ」と「書く1つ」（書く欄は4行）・「確認」で入力を固めて戻る／送信を横に並べ・
// 送ったあとは結果と「GitHub に戻る」だけ。確かめは項目を並べ、「完了にする」のチェック1つで答える（項目ごとの欄は持たない）。
// 次のステータスは出さない。答えはユーザーの名義（env.FORM_TOKEN）でコメントに書き、ラベルの付け外しも同じ名義で打つ。
// 行き先はゲートが答えから決め、書いた文があれば Claude が読んでから当てる。
import { GitHub } from "./github.js";
import { END, jstText } from "./facts.js";
import { CHOICES, DONE, NONE, answerBody, answerProblem, bodyRest, confirmItems, isQuestion, latestQuestion, norm } from "./questions.js";

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
.items{margin:0;padding-left:1.1em;font-size:13px}.check{display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid #8884;font-weight:500}
.check input{width:18px;height:18px}.hint{font-size:12px;opacity:.7;margin:4px 0 0}</style></head><body>${inner}${SCRIPT}</body></html>`,
{ status, headers: { "content-type": "text/html; charset=utf-8" } });

async function read(gh, config, number) {
  const { owner: o, name: n } = config.repos.tasks;
  const r = await gh.gql(`query($o:String!,$n:String!,$i:Int!){repository(owner:$o,name:$n){labels(first:100){nodes{name}}
    issue(number:$i){id title url body labels(first:50){nodes{name}} comments(last:40){nodes{body bodyHTML url createdAt author{login}}}}}}`, { o, n, i: number });
  const { issue, labels } = r.repository;
  const comments = issue.comments.nodes;
  const question = latestQuestion(comments.map((c) => c.body), config.questionTemplate); // ゲートと同じく、形に合わない問いは問いとして読まない
  const asked = comments.findLast((c) => isQuestion(c.body));
  return { issue, comments, asked, question, all: labels.nodes.map((l) => l.name), have: issue.labels.nodes.map((l) => l.name) };
}

const seg = (name, values) => `<div class="seg">${values.map((v, i) => `<label><input type="radio" name="${name}" value="${esc(v)}"${i ? "" : " checked"}>${esc(v)}</label>`).join("")}</div>`;
const box = (type, name, value, text, extra = "", cls = "opt") => `<label class="${cls}"><input type="${type}" name="${name}" value="${esc(value)}"${extra}><span>${esc(text)}</span></label>`;
const fold = (title, inner, open = false) => (inner ? `<details${open ? " open" : ""}><summary>${title}</summary><div>${inner}</div></details>` : "");

// 問いの種類ごとの選ぶ欄。判断は案（無ければ書く欄だけ）、確かめは項目の一覧と「完了にする」のチェック1つ、採否とイレギュラーは決まった選択肢。
function answerField(q, items) {
  if (q.kind === "判断") return q.plans.length ? `<p class="sec">回答</p>${[...q.plans, NONE].map((p) => box("radio", "choice", p, p)).join("")}` : "";
  if (q.kind === "確かめ") return `<p class="sec">確かめること</p><ul class="items">${items.map((t, i) => `<li>${esc(t)}<input type="hidden" name="item${i}" value="${esc(t)}"></li>`).join("")}</ul>
    ${box("checkbox", "done", "on", `${DONE}（上の全部）`, "", "check")}`;
  return `<p class="sec">回答</p>${seg("choice", CHOICES[q.kind])}`;
}

async function submit(gh, env, config, number, form) {
  const { issue, question: q, all, have } = await read(gh, config, number);
  if (!q || q.answer) return { error: "答えていない問いがありません。" };
  if (form.get("question") !== q.text) return { error: "問いが新しくなっています。開き直してください。" };
  // 確かめの項目は開いたときの文で送られる。今の本文の残りに無い項目があれば、開いたあとに本文が変わったので開き直してもらう。
  const items = [...form.keys()].filter((k) => /^item\d+$/.test(k)).map((k) => form.get(k));
  if (items.some((t) => !confirmItems(issue.body).includes(t))) return { error: "本文の完了の条件が変わっています。開き直してください。" };
  const answer = { choice: form.get("choice"), done: q.kind === "確かめ" && form.get("done") === "on", items, text: String(form.get("note") ?? "").trim() };
  const problem = answerProblem(q, answer);
  if (problem) return { error: problem };
  const chosen = form.getAll("label").filter((n) => all.includes(n));
  const added = chosen.filter((n) => !have.includes(n));
  const removed = have.filter((n) => all.includes(n) && !chosen.includes(n));
  const labels = [...added.map((n) => `+${n}`), ...removed.map((n) => `−${n}`)].join(" ");
  const user = new GitHub(env.FORM_TOKEN);
  const path = `/repos/${config.tasks}/issues/${number}`;
  await user.rest("POST", `${path}/comments`, { body: answerBody(q, { ...answer, labels }) });
  await Promise.all([added.length && user.rest("POST", `${path}/labels`, { labels: added }),
    ...removed.map((n) => user.rest("DELETE", `${path}/labels/${encodeURIComponent(n)}`))].filter(Boolean));
  return { url: issue.url, label: answer.choice || (answer.done ? DONE : "書いたこと") };
}

export async function answerForm(request, env, config) {
  const number = Number(new URL(request.url).searchParams.get("issue"));
  const gh = await GitHub.app(env, config.installation);
  if (request.method === "POST") return Response.json(await submit(gh, env, config, number, await request.formData()));
  const { issue, comments, asked, question: q, all, have } = await read(gh, config, number);
  if (!q || q.answer) return page(`<p>#${number} に、答えていない問いはありません。</p>`, 404);
  const said = q.kind === "イレギュラー" ? comments.findLast((c) => END.test(norm(c.body)))?.bodyHTML : null;
  const recent = comments.filter((c) => c !== asked).slice(-RECENT).reverse()
    .map((c) => `<p class="note"><a href="${esc(c.url)}">${esc(c.author?.login ?? "ghost")} ・ ${jstText(Date.parse(c.createdAt))}</a></p>${c.bodyHTML}`).join("");
  // 判断材料と本文は GitHub の Markdown の描き方で HTML にする。互いに独立なので並べて打つ。
  const md = (text) => (text ? gh.rest("POST", "/markdown", { text, mode: "gfm", context: config.tasks }) : "");
  const [material, body] = await Promise.all([md(q.material), md(bodyRest(issue.body).trim())]);
  return page(`<p class="num">#${number}</p><p class="title">${esc(issue.title)}</p><p>${esc(q.text)}</p>${said ? `<div>${said}</div>` : ""}
${fold("判断材料", material, true)}${fold("本文", body)}${fold("最近のコメント", recent)}
<form><input type="hidden" name="question" value="${esc(q.text)}"><div class="inp">${answerField(q, confirmItems(issue.body))}
<textarea name="note" rows="4" placeholder="書くこと（任意）" aria-label="書くこと"></textarea>
<p class="hint">書けば Claude が読んでから進みます。${q.kind === "確かめ" ? "直してほしいことも、ここに書きます。" : ""}</p>
<details class="labels"><summary class="s">ラベル（任意）</summary><div>${all.map((n) => box("checkbox", "label", n, n, have.includes(n) ? " checked" : "", "")).join("")}</div></details>
</div><p id="err"></p><button type="button" id="go" class="sub">確認</button><div class="row"><button type="button" id="back" class="sub">戻る</button><button class="main">送信</button></div></form>`);
}
