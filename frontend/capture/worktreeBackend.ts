import type { APIResponse, Page, Route } from "@playwright/test";

// 撮影で、選んだパスの頭の要求だけを作業ツリーの backend（scripts/capture.mjs の --backend）へ向ける。

export interface WorktreeBackend {
  /** 作業ツリーの backend（backend/scripts/serve_capture.py）のオリジン。 */
  origin: string;
  /** --api の backend のオリジン。 */
  api: string;
  /** 作業ツリーの backend に返させるパスの頭（scripts/capture.mjs の --backend）。 */
  paths: string[];
}

/**
 * 作業ツリーの backend の応答を待つ上限。気象庁のタイルの中継は気象庁への秒間上限を守って待つ（backend/app/config.py:
 * jma_tile_upstream_max_requests_per_second）ので、地図が一度に取るタイルの数だけ待ちが積もる。
 */
const WORKTREE_BACKEND_TIMEOUT_MS = 5 * 60_000;

function forWorktreeBackend(url: URL, { api, paths }: WorktreeBackend): boolean {
  return url.origin === new URL(api).origin && paths.some((head) => url.pathname.startsWith(head));
}

/**
 * 要求を、選んだパスの頭に当たれば作業ツリーの backend へ、ほかは向け先のまま送った応答。page.route の route.fetch は
 * 向け先のプロトコルを変えられない（本番の https から手元の http へ替えられない）ので、作業ツリーの backend へは page.request で
 * 同じメソッド・ヘッダー・本文を送る。
 */
export async function upstream(
  page: Page,
  route: Route,
  worktreeBackend: WorktreeBackend | null,
): Promise<APIResponse> {
  const request = route.request();
  const url = new URL(request.url());
  if (!worktreeBackend || !forWorktreeBackend(url, worktreeBackend)) return route.fetch();
  return page.request.fetch(`${worktreeBackend.origin}${url.pathname}${url.search}`, {
    method: request.method(),
    headers: request.headers(),
    data: request.postDataBuffer() ?? undefined,
    timeout: WORKTREE_BACKEND_TIMEOUT_MS,
  });
}

/**
 * ブラウザが --api の backend へ選んだパスの頭で取りに行くものを、作業ツリーの backend から取って返す。
 * 脚本の routes・patch より先に登録する（後から登録したルートが先に当たる）。
 */
export async function routeToWorktreeBackend(page: Page, worktreeBackend: WorktreeBackend): Promise<void> {
  await page.route(
    (url) => forWorktreeBackend(url, worktreeBackend),
    async (route) => {
      await route.fulfill({ response: await upstream(page, route, worktreeBackend) });
    },
  );
}
