// 管理APIのパスの接頭辞。管理画面は同一オリジンの転送の口を叩き、転送の口がbackendの管理APIへ読み替える。

/** 管理画面が叩く同一オリジンの転送の口（`app/admin/api/[...path]/route.ts`。ディレクトリの置き場がこのパスを決める）。 */
export const ADMIN_PROXY_PREFIX = "/admin/api";

/** backendの管理APIの接頭辞。 */
export const BACKEND_ADMIN_PREFIX = "/api/admin";
