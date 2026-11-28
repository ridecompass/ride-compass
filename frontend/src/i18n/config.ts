// 画面の文の辞書（messages/ja.json）を読む所。部品は `next-intl` の `useTranslations`、非同期の Server の部品は
// `getTranslations` で引き、部品の外（フックの外の純関数・モジュールの定数）は下の `translate` で引く。
import { createTranslator } from "next-intl";
import messages from "../../messages/ja.json";

export const intlConfig = { locale: "ja", messages, timeZone: "Asia/Tokyo" } as const;

/** 部品の外で辞書を引く口。 */
export const translate = createTranslator(intlConfig);
