"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { checkBackendHealth } from "@/features/admin/adminApi";
import { cn } from "@/lib/cn";
import { getQueryClient } from "@/lib/queryClient";

export default function BackendStatus() {
  const t = useTranslations("admin.backendStatus");
  const { status: queryStatus, error } = useQuery(
    { queryKey: ["backend-health"], queryFn: checkBackendHealth },
    getQueryClient(),
  );
  const status = { pending: "checking", success: "ok", error: "ng" }[queryStatus] as "checking" | "ok" | "ng";

  // 正常時は静かに（小さく・淡く）、異常時だけ目立たせる。常時「OK」を主張する必要は無く、
  // ユーザーが気にすべきは「使えない理由」があるときだけという考え方。
  const label = { checking: t("checking"), ok: t("ok"), ng: error?.message }[status];
  const statusClass = {
    checking: "text-[var(--color-muted-strong)]",
    ok: "text-[var(--color-muted)]",
    ng: "font-semibold text-[var(--color-danger-text)]",
  }[status];

  return (
    <span role="status" data-state={status} className={cn("text-[length:var(--font-size-sm)]", statusClass)}>
      {label}
    </span>
  );
}
