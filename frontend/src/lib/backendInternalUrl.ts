// サーバー側（Next.jsのプロセス）からbackendへ届くURL。ブラウザ向けのNEXT_PUBLIC_API_URLとは値が違いうる。
// next.config.tsから相対importで読まれるので、`@/`のimportを持たない。
export const BACKEND_INTERNAL_URL = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:8000";
