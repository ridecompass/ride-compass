"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { formatJstDateTime } from "@/lib/time";
import { errorMessage } from "@/lib/apiError";
import FloatingPanel from "@/components/FloatingPanel/FloatingPanel";
import { getDebugStats } from "@/features/admin/adminApi";
import { frontendVersionQuery } from "@/services/versionApi";
import { getQueryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/Button/Button";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table/Table";
import { Badge } from "@/components/ui/Badge/Badge";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

interface SystemStatusPanelProps {
  open: boolean;
  onClose: () => void;
}

function formatIsoJst(iso: string): string {
  return formatJstDateTime(new Date(iso));
}

function formatLastError(error: { type: string; at: string } | null): string {
  if (error === null) return "—";
  return `${error.type} (${formatIsoJst(error.at)})`;
}

const SECTION_HEADING_CLASS = cn(textVariants({ variant: "note" }), "tracking-wide uppercase");

/** 動いている版（commit・起動日時）のカード。フロントとバックで同じ形。 */
function VersionCard({
  title,
  error,
  version,
  children,
}: {
  title: string;
  error: string | null;
  version: { commit: string | null; started_at: string } | null;
  children?: ReactNode;
}) {
  const t = useTranslations("admin.systemStatus");
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5">
      <span className={SECTION_HEADING_CLASS}>{title}</span>
      {error && <span className="text-[var(--color-danger-text)]">{t("failed", { message: error })}</span>}
      {version && (
        <>
          <span className="font-semibold [overflow-wrap:anywhere]">{version.commit ?? t("localCommit")}</span>
          <span className="text-[var(--color-muted)]">{t("startedAt", { at: formatIsoJst(version.started_at) })}</span>
          {children}
        </>
      )}
    </div>
  );
}

// フロント・バックそれぞれの適用バージョン（commit・起動日時）とバックエンドの外部API
// 呼び出しサマリを、ログ本文とは別の独立パネルとして表示する（設定内のボタンから開閉）。
// プロセス内カウンタ（バックエンド）・モジュール評価時刻（フロント）のスナップショットのため、
// ポーリングはせず開いたときと「更新」ボタン押下時にだけ取得する。
export default function SystemStatusPanel({ open, onClose }: SystemStatusPanelProps) {
  const t = useTranslations("admin.systemStatus");
  const client = getQueryClient();
  const backendQuery = useQuery({ queryKey: ["debug-stats"], queryFn: getDebugStats, enabled: open }, client);
  const frontendQuery = useQuery({ ...frontendVersionQuery, enabled: open }, client);
  const backend = backendQuery.data ?? null;
  const frontend = frontendQuery.data ?? null;
  const backendError = backendQuery.error && errorMessage(backendQuery.error);
  const frontendError = frontendQuery.error && errorMessage(frontendQuery.error);
  // 「更新」は両方が届くまで押せない（速い方が先に届いた時点で押せると、遅い方の取得中に重ねて取りに行く）。
  const loading = backendQuery.isFetching || frontendQuery.isFetching;
  const fetchAll = () => {
    void backendQuery.refetch();
    void frontendQuery.refetch();
  };

  const externalEntries = backend ? Object.entries(backend.external) : [];
  const rejectionEntries = backend ? Object.entries(backend.rate_limit_rejections) : [];
  const msm = backend?.msm ?? null;

  return (
    <FloatingPanel
      open={open}
      onClose={onClose}
      title={t("title")}
      // デバッグログパネル（`components/DebugConsole/DebugConsole.tsx: DebugConsole`）と同時に開いても
      // 両方のヘッダーが見えるよう、それより下に置く（同じ位置だと後から開いた方が完全に覆い隠す）。
      // ドラッグで動かせるので、重なった場合はどちらかを移動すればよい。
      topRem={8.5}
      widthRem={24}
      maxHeightPx={480}
      headerButtons={
        <Button usage={null} size="xs" onClick={fetchAll}>
          {loading ? t("refreshing") : t("refresh")}
        </Button>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 py-1.5">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2">
          <VersionCard title={t("frontend")} error={frontendError} version={frontend} />
          <VersionCard title={t("backend")} error={backendError} version={backend}>
            <span className="text-[var(--color-muted)]">
              {/* 値を要素（Fragment）で返し、前の文と別のテキストのノードにする（文字列で返すと前の文とつながって1つのノードになり、
                  空白の後ろの字の位置が画素で変わる）。 */}
              {t.rich("debugMode", { state: () => <>{t(backend?.debug_mode ? "on" : "off")}</> })}
            </span>
          </VersionCard>
        </div>

        {msm && (
          <div
            className="flex flex-col gap-1 rounded-sm border border-[var(--color-border)] p-2 data-[healthy=false]:border-[var(--color-danger)]"
            data-healthy={msm.healthy ? "true" : "false"}
          >
            <span className={SECTION_HEADING_CLASS}>{t("msm")}</span>
            <span className="text-[var(--color-muted)]">
              {t("msmRun", { at: formatIsoJst(msm.last_run_at), ageHours: String(msm.run_age_hours) })}
              {t("msmRemaining", { hours: String(msm.remaining_hours) })}
            </span>
            {!msm.healthy && <span className="text-[var(--color-danger-text)]">{t("msmStalled")}</span>}
          </div>
        )}

        {externalEntries.length > 0 && (
          <>
            <div className={cn(SECTION_HEADING_CLASS, "mt-1")}>{t("external")}</div>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeader>{t("category")}</TableHeader>
                  <TableHeader>{t("calls")}</TableHeader>
                  <TableHeader>{t("errors")}</TableHeader>
                  <TableHeader>{t("lastError")}</TableHeader>
                  <TableHeader>{t("hitRate")}</TableHeader>
                  <TableHeader>{t("average")}</TableHeader>
                  <TableHeader>{t("max")}</TableHeader>
                </TableRow>
              </TableHead>
              <tbody>
                {externalEntries.map(([category, s]) => {
                  // エラー件数の下に原因別件数を1行に1つずつ小さく添える。一覧に列を増やさずに「429かタイムアウトか」等を
                  // 読めるようにする（titleはスマホで出ない）。
                  const errorTypeParts = Object.entries(s.error_types).map(([type, count]) => `${type}:${count}`);
                  return (
                    <TableRow
                      key={category}
                      data-level={s.errors > 0 ? "error" : undefined}
                      className="data-[level=error]:text-[var(--color-danger-text)]"
                    >
                      <TableCell className="text-[var(--color-accent-text)] in-data-[level=error]:text-[var(--color-danger-text)]">
                        {category}
                      </TableCell>
                      <TableCell>{s.calls}</TableCell>
                      <TableCell>
                        {s.errors}
                        {errorTypeParts.map((part) => (
                          <span key={part} className={cn(textVariants({ variant: "note" }), "block whitespace-nowrap")}>
                            {part}
                          </span>
                        ))}
                      </TableCell>
                      <TableCell>{formatLastError(s.last_error)}</TableCell>
                      <TableCell>{s.cache_hit_rate != null ? `${Math.round(s.cache_hit_rate * 100)}%` : "—"}</TableCell>
                      <TableCell>{t("milliseconds", { value: String(s.avg_ms) })}</TableCell>
                      <TableCell>{t("milliseconds", { value: String(s.max_ms) })}</TableCell>
                    </TableRow>
                  );
                })}
              </tbody>
            </Table>
          </>
        )}

        {rejectionEntries.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {rejectionEntries.map(([category, count]) => (
              <Badge key={category} variant="warning">
                {t("rejected", { category, count: String(count) })}
              </Badge>
            ))}
          </div>
        )}

        {!backend && !frontend && !backendError && !frontendError && (
          <p className={textVariants({ variant: "hint" })}>{t("fetching")}</p>
        )}
      </div>
    </FloatingPanel>
  );
}
