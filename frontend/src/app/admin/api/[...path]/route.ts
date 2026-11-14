// `/admin/api/<X>`への要求を、backendの管理API`/api/admin/<X>`（いずれもHTTP Basic認証必須）へそのまま渡す。
//
// ブラウザは/adminで入力したBasic認証情報を別オリジンのbackendへ送らないため、管理画面のJSはこの同一オリジンの
// 口を叩く（ブラウザは同一オリジン・同一realmの後続要求へ認証キャッシュを自動で付ける）。backend宛の資格情報は
// ここでサーバーの環境変数から組み立てるため、ブラウザへは出ない。route handlerはサーバーでだけ動く。

import { BACKEND_INTERNAL_URL } from "@/lib/backendInternalUrl";
import { ADMIN_PROXY_TIMEOUT_MS } from "@/lib/apiTimeouts";
import { adminBasicAuthCredentials } from "@/lib/adminBasicAuth";
import { ADMIN_PROXY_PREFIX, BACKEND_ADMIN_PREFIX } from "@/lib/adminApiPrefix";

async function forward(request: Request): Promise<Response> {
  const credentials = adminBasicAuthCredentials();
  if (credentials === null) {
    return Response.json(
      { detail: "サーバー側の管理者資格情報（ADMIN_BASIC_AUTH_USERNAME/PASSWORD）が未設定です" },
      { status: 500 },
    );
  }

  // パスは受けたままの符号化で渡す（区間の値に入った区切り文字を復号し直さない）。URLの解析が`..`を
  // 解決した後のパスで接頭辞を確かめるので、`/admin/api`の外は指せない。
  const { pathname, search } = new URL(request.url);
  if (!pathname.startsWith(`${ADMIN_PROXY_PREFIX}/`)) return new Response(null, { status: 404 });
  const backendPath = `${BACKEND_ADMIN_PREFIX}${pathname.slice(ADMIN_PROXY_PREFIX.length)}`;
  const hasBody = request.method === "POST" || request.method === "PUT";
  // 本文は応答の頭が届いたあとにも切れる・時間切れになるので、読み終えるまでを同じ失敗として扱う。
  try {
    const backendResponse = await fetch(`${BACKEND_INTERNAL_URL}${backendPath}${search}`, {
      method: request.method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      body: hasBody ? await request.text() : undefined,
      signal: AbortSignal.timeout(ADMIN_PROXY_TIMEOUT_MS),
    });
    if (backendResponse.status === 204) return new Response(null, { status: 204 });
    return new Response(await backendResponse.text(), {
      status: backendResponse.status,
      headers: { "Content-Type": backendResponse.headers.get("content-type") ?? "application/json" },
    });
  } catch (error) {
    // detailは管理画面の本文へそのまま出るため、ランタイム由来の英語の文言（"fetch failed"等）は
    // 入れず、原因の追跡用にサーバーのログへだけ残す。
    console.error(`admin proxy: ${backendPath}`, error);
    const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
    return Response.json(
      { detail: `backendへの接続に失敗しました[${isTimeout ? "タイムアウト" : "通信エラー"}]` },
      { status: 502 },
    );
  }
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const DELETE = forward;
