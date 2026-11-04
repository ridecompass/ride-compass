// 一次属性（生データ）の名前。源泉の宣言から導く。

import { primaryAttributes as primaryAttributeCatalog } from "@/types/generated/primaryAttributes";

/** 属性id→正式名。 */
export const PRIMARY_ATTRIBUTE_LABELS: Record<string, string> = Object.fromEntries(
  primaryAttributeCatalog.map((attr) => [attr.attr_id, attr.label]),
);
