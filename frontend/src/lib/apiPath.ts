import { fillTemplate } from "@/lib/urlTemplate";
import type { paths } from "@/types/generated/api";

type PathParams<P extends string> = P extends `${string}{${infer Name}}${infer Rest}` ? Name | PathParams<Rest> : never;

/**
 * backendが宣言したパス（OpenAPIの生成物`paths`のキー）の`{名前}`を`params`の値で埋めた、アプリ自身が呼ばないURLの
 * パス（地図ライブラリへ渡すタイル・スタイル）。渡さなかった名前は`{名前}`のまま残る。アプリ自身が呼ぶ口は
 * `lib/apiClient.ts`で呼ぶ。
 */
export function apiPath<P extends keyof paths>(
  path: P,
  params: Partial<Record<PathParams<P>, string | number>> = {},
): string {
  return fillTemplate(path, params);
}
