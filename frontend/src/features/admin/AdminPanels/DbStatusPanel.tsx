"use client";

import { useTranslations } from "next-intl";
import { GuideText } from "@/components/ui/GuideText/GuideText";
import { translate } from "@/i18n/config";
import { vocabulary } from "@/types/generated/vocabulary";
import { getDbStatus } from "@/features/admin/adminApi";
import { formatMinutes, secondsToMinutes } from "@/lib/duration";
import type { DbStatusResponse } from "@/types/route";
import { formatCount, formatMoment, ReportCard } from "./ReportCard";
import { type StatusRow, StatusRowList, StatusVerdict } from "./StatusRowList";

function formatBytes(value: number): string {
  const mb = value / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function rowsAndBytes(rows: number, bytes: number): string {
  return translate("admin.dbStatus.rowsAndBytes", { rows: formatCount(rows), bytes: formatBytes(bytes) });
}

function formatDuration(seconds: number): string {
  if (secondsToMinutes(seconds) < 1)
    return translate("admin.dbStatus.seconds", { seconds: String(Math.round(seconds)) });
  return formatMinutes(seconds);
}

/** 「データ保守」タブの他のパネルと同じ1行の形。判定の種類（取込・テーブル・接続）が違っても、
 * 読み手が知りたいのは「注意が要るか」で同じなので見た目を揃える。
 *
 * 行の見た目を揃えたぶん、何と何が並んでいるのかは見出しが引き受ける。並び順に根拠がある
 * 群（テーブルは容量の大きい順）は、その根拠も見出しへ書く。 */
interface StatusGroup {
  title: string;
  rows: StatusRow[];
}

/** 取込のrunの状態の呼び名（backendの宣言`SOURCE_RUN_STATUS_LABELS`）。宣言に無い状態は生のまま出す。 */
function runStatusLabel(status: string): string {
  return vocabulary.sourceRunStatuses.find((entry) => entry.key === status)?.label ?? status;
}

function groupsFromStatus(report: DbStatusResponse): StatusGroup[] {
  const imports: StatusRow[] = report.imports.map((entry) => ({
    name: entry.label,
    scale: translate("admin.dbStatus.runScale", {
      id: String(entry.latest.id),
      status: runStatusLabel(entry.latest.status),
    }),
    flagged: entry.needs_attention,
    detail: [
      {
        label: translate("admin.dbStatus.latestRun"),
        value: translate("admin.dbStatus.runAt", {
          id: String(entry.latest.id),
          at: formatMoment(entry.latest.finished_at),
        }),
      },
      {
        label: translate("admin.dbStatus.latestSucceeded"),
        value:
          entry.latest_succeeded === null
            ? translate("admin.dbStatus.none")
            : translate("admin.dbStatus.runAt", {
                id: String(entry.latest_succeeded.id),
                at: formatMoment(entry.latest_succeeded.finished_at),
              }),
      },
      ...(entry.latest.item_count === null
        ? []
        : [
            {
              label: translate("admin.dbStatus.itemCount"),
              value: translate("admin.dbStatus.count", { count: formatCount(entry.latest.item_count) }),
            },
          ]),
      ...Object.entries(entry.latest.identity).map(([key, value]) => ({
        label: key,
        value,
      })),
    ],
    note: entry.note || undefined,
  }));

  const connectionCount = `${report.connections.total} / ${report.connections.max_connections}`;
  const connections: StatusRow = {
    // 見出しの「接続」と同じ名前にすると、群と行の区別がつかない。
    name: translate("admin.dbStatus.connectionsRow"),
    scale: connectionCount,
    flagged: report.connections.needs_attention,
    detail: [
      { label: translate("admin.dbStatus.connectionCount"), value: connectionCount },
      {
        label: translate("admin.dbStatus.idleInTransaction"),
        value:
          report.connections.idle_in_transaction === 0
            ? translate("admin.dbStatus.none")
            : translate("admin.dbStatus.idleInTransactionValue", {
                count: String(report.connections.idle_in_transaction),
                longest: formatDuration(report.connections.longest_idle_transaction_seconds),
              }),
      },
      {
        label: translate("admin.dbStatus.longestQuery"),
        value:
          report.connections.longest_query_seconds <= 0
            ? translate("admin.dbStatus.none")
            : formatDuration(report.connections.longest_query_seconds),
      },
    ],
    note: report.connections.note || undefined,
  };

  // テーブルは数が多く（本番で20件超）、全部を並べると注意すべき行が埋もれる。注意のある
  // ものだけを行にし、残りは1行へ畳んで開いた先に一覧を置く。
  const tableRow = (entry: DbStatusResponse["tables"][number]): StatusRow => ({
    name: entry.table_name,
    scale: rowsAndBytes(entry.row_count, entry.total_bytes),
    flagged: entry.needs_attention,
    detail: [
      {
        label: translate("admin.dbStatus.rowCount"),
        value: translate("admin.dbStatus.rowCountValue", { count: formatCount(entry.row_count) }),
      },
      { label: translate("admin.dbStatus.totalBytes"), value: formatBytes(entry.total_bytes) },
      { label: translate("admin.dbStatus.analyzedAt"), value: formatMoment(entry.analyzed_at) },
      { label: translate("admin.dbStatus.vacuumedAt"), value: formatMoment(entry.vacuumed_at) },
      ...(entry.dead_tuples > 0
        ? [
            {
              label: translate("admin.dbStatus.deadTuples"),
              value: translate("admin.dbStatus.count", { count: formatCount(entry.dead_tuples) }),
            },
          ]
        : []),
    ],
    note: entry.note || undefined,
  });

  const flagged = report.tables.filter((entry) => entry.needs_attention).map(tableRow);
  const rest = report.tables.filter((entry) => !entry.needs_attention);
  // 畳んだ行は、分けた基準（注意の有無）を自分で名乗る。「その他」では、隠された側が
  // 重要でないから省かれたのか、見るべきものが埋もれているのかが読めない。
  const restRow: StatusRow[] = rest.length
    ? [
        {
          name: translate("admin.dbStatus.calmTables", { count: String(rest.length) }),
          scale: rowsAndBytes(sumRows(rest), sumBytes(rest)),
          flagged: false,
          detail: rest.map((entry) => ({
            label: entry.table_name,
            value: rowsAndBytes(entry.row_count, entry.total_bytes),
          })),
        },
      ]
    : [];

  const tables = [...flagged, ...restRow];
  return [
    { title: translate("admin.dbStatus.imports"), rows: imports },
    { title: translate("admin.dbStatus.connections"), rows: [connections] },
    ...(tables.length ? [{ title: translate("admin.dbStatus.tables"), rows: tables }] : []),
  ];
}

function sumRows(entries: DbStatusResponse["tables"]): number {
  return entries.reduce((sum, entry) => sum + entry.row_count, 0);
}

function sumBytes(entries: DbStatusResponse["tables"]): number {
  return entries.reduce((sum, entry) => sum + entry.total_bytes, 0);
}

/** ヘッダーへ出す母数。畳んだ行の「N テーブル」が何分のNなのかは、全体の数が同じ画面に
 * 無いと読めない。 */
function summaryOf(report: DbStatusResponse): string {
  return [
    translate("admin.dbStatus.tableCount", { count: formatCount(report.tables.length) }),
    translate("admin.dbStatus.totalRows", { count: formatCount(sumRows(report.tables)) }),
    formatBytes(report.database_bytes),
  ].join(translate("admin.separator"));
}

// 「データ保守」タブ（/admin）で、本番DBの土台の側を見る——取込runが
// 失敗していないか、行が本当に入っているか、プランナが使う統計が取れているか、
// トランザクションが放置されていないか。
export default function DbStatusPanel() {
  const t = useTranslations("admin.dbStatus");
  return (
    <ReportCard title={t("title")} info={<GuideText text={t("info")} />} load={getDbStatus} summary={summaryOf}>
      {(report) => <StatusRows report={report} />}
    </ReportCard>
  );
}

/** 行の描画。取得と分けてあるのは、認証の要る画面を通さずに見え方を確かめられるようにするため。 */
function StatusRows({ report }: { report: DbStatusResponse }) {
  const t = useTranslations("admin.dbStatus");
  const groups = groupsFromStatus(report);
  const attentionCount = groups.flatMap((group) => group.rows).filter((row) => row.flagged).length;
  return (
    <>
      <StatusVerdict flagged={attentionCount > 0}>
        <span>{attentionCount > 0 ? t("attention", { count: String(attentionCount) }) : t("noAttention")}</span>
      </StatusVerdict>
      <StatusRowList groups={groups} flaggedLabel={t("flagged")} okLabel={t("ok")} />
    </>
  );
}
