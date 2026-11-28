// 辞書の ID と差し込む値の型。型は `next-intl/plugin` の `createMessagesDeclaration`（next.config.ts）が `next dev`・
// `next build`・`next typegen` のたびに書き出す messages/ja.d.json.ts から取る。
import type messages from "../../messages/ja.json";

declare module "next-intl" {
  interface AppConfig {
    Locale: "ja";
    Messages: typeof messages;
  }
}
