// GitHub の REST と GraphQL を、App（env.APP_ID と PKCS#8 の env.APP_KEY）のインストールの名義で打つ。失敗には、やり直せば直りうるか
// （5xx・つながらない・REST と GraphQL の上限）を transient で付け、上限なら打ち直してよい時刻を retryAt に載せる（やり直すのは src/inbox.js: Inbox）。
const API = "https://api.github.com";
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fail = (message, transient, retryAt) => Object.assign(new Error(message), { transient, retryAt });
// 上限の応答（GitHub の公式の文書「Rate limits for the REST API」の「Exceeding the rate limit」）なら打ち直してよい時刻、そうでなければ null。上限は 403 か 429 で、
// retry-after（秒）か x-ratelimit-remaining が 0（x-ratelimit-reset の時刻まで待つ）か、二次の上限の文で示す。どちらの時刻も無い二次の上限は、少なくとも1分待つ。
function limitedUntil(status, headers, text, now = Date.now()) {
  if (status !== 403 && status !== 429) return null;
  const after = headers.get("retry-after");
  if (after !== null) return now + Number(after) * 1000;
  if (headers.get("x-ratelimit-remaining") === "0") return Number(headers.get("x-ratelimit-reset")) * 1000 || now + 60e3;
  return status === 429 || /secondary rate limit/i.test(text) ? now + 60e3 : null;
}
// インストールの鍵は GitHub が返す失効の時刻まで変わらないので、失効の5分前まで使い回す（作るのも GitHub への要求1回）。鍵だけを持ち、issue の情報は持たない。
const held = new Map();

export class GitHub {
  constructor(token) {
    this.token = token;
  }

  static async app(env, installation) {
    if (held.get(installation)?.expires - Date.now() > 5 * 60e3) return held.get(installation);
    const der = Uint8Array.from(atob(env.APP_KEY.replace(/-----[^-]+-----|\s+/g, "")), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const now = Math.floor(Date.now() / 1000);
    const part = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
    const data = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: String(env.APP_ID) })}`;
    const jwt = `${data}.${b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data)))}`;
    const t = await new GitHub(jwt).rest("POST", `/app/installations/${installation}/access_tokens`);
    return held.set(installation, Object.assign(new GitHub(t.token), { expires: Date.parse(t.expires_at) })).get(installation);
  }

  async rest(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "ridecompass-flow" },
      body: body === undefined ? body : JSON.stringify(body),
    }).catch((e) => { throw fail(e.message, true); });
    if (!res.ok) {
      const text = await res.text();
      const until = limitedUntil(res.status, res.headers, text);
      throw fail(`GitHub ${method} ${path}: ${res.status} ${text.slice(0, 200)}`, res.status >= 500 || until !== null, until ?? undefined);
    }
    // 本文の無い応答は null、JSON でない応答（Markdown の描画の HTML 等）は文字列。
    return res.status === 204 ? null : res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
  }

  async gql(query, variables = {}) {
    const r = await this.rest("POST", "/graphql", { query, variables });
    if (r.errors) throw fail(`GraphQL: ${r.errors.map((e) => e.message).join(" / ")}`, r.errors.some((e) => e.type === "RATE_LIMITED"));
    return r.data;
  }
}
// ページを送って、接続（at が応答から引く。pageInfo と nodes を持つ）の要素を順に出す。問い合わせの $a が次のページの位置。
export async function* pages(gh, query, vars, at) {
  for (let a = null; ;) {
    const c = at(await gh.gql(query, { ...vars, a }));
    yield* c.nodes;
    if (!c.pageInfo.hasNextPage) return;
    a = c.pageInfo.endCursor;
  }
}

// 書き込みの並び（[書き込みの名前, 入力の型, 入力]）を、1回の要求の問い合わせと変数にする。宣言する変数は並べた書き込みが使うものだけ（GitHub は
// 使わない変数を宣言した問い合わせを断る）。
export const batch = (ops) => [`mutation(${ops.map(([, type], k) => `$v${k}:${type}!`).join(",")}){${ops.map(([name], k) => `w${k}:${name}(input:$v${k}){clientMutationId}`).join(" ")}}`,
  Object.fromEntries(ops.map(([, , input], k) => [`v${k}`, input]))];
