"use client";

import { useTranslations } from "next-intl";
import { vocabulary } from "@/types/generated/vocabulary";
import { getMaterialCoverage } from "@/features/admin/adminApi";
import { formatCount, ReportCard } from "./ReportCard";
import type { MaterialCoverageEntry, MaterialCoverageResponse } from "@/types/route";
import { Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table/Table";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

type CountedEntry = Extract<MaterialCoverageEntry, { kind: "counted" }>;
type ExcludedEntry = Extract<MaterialCoverageEntry, { kind: "excluded" }>;

// 母集団の名前と欠損の扱いの見出し・説明は、材料カタログの宣言（backend domain/material_catalog.py）が配る。
const POPULATION_LABELS = Object.fromEntries(vocabulary.materialPopulations.map((p) => [p.key, p.label])) as Record<
  CountedEntry["population"],
  string
>;

function formatPercent(ratio: number | null): string {
  return ratio === null ? "-" : `${(ratio * 100).toFixed(1)}%`;
}

/** 集計対象の材料を欠損割合の高い順に並べる（同率はカタログ順を維持する安定ソート）。 */
function sortByMissingRatioDesc(entries: readonly CountedEntry[]): CountedEntry[] {
  return [...entries].sort((a, b) => (b.missing_ratio ?? -1) - (a.missing_ratio ?? -1));
}

type MissingSemantics = CountedEntry["missing_semantics"];

// 「欠損時の扱い」でグループ分けする（見出しと並びはbackendの宣言）。宣言に無い扱い（backendを先に出すと、
// 生成物にまだ無い扱いが届く）の材料は、下の未分類グループが拾う——表から消える材料を作らない。
const GROUP_BY_SEMANTICS = Object.fromEntries(
  vocabulary.materialMissingSemantics.map((entry) => [
    entry.key,
    { title: entry.title, hint: entry.hint, affectsEvaluation: entry.affects_evaluation },
  ]),
) as Record<MissingSemantics, { title: string; hint: string; affectsEvaluation: boolean }>;

const GROUPED_SEMANTICS = new Set<string>(Object.keys(GROUP_BY_SEMANTICS));

function CoverageTable({ entries }: { entries: readonly CountedEntry[] }) {
  const t = useTranslations("admin.materials");
  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableHeader scope="col">{t("material")}</TableHeader>
          <TableHeader scope="col">{t("population")}</TableHeader>
          <TableHeader scope="col">{t("missingRatio")}</TableHeader>
        </TableRow>
      </TableHead>
      <tbody>
        {entries.map((entry) => (
          <TableRow
            key={entry.material_id}
            data-affects-evaluation={String(GROUP_BY_SEMANTICS[entry.missing_semantics]?.affectsEvaluation)}
          >
            <TableCell>
              {entry.label}
              <span className={cn(textVariants({ variant: "note" }), "block [overflow-wrap:anywhere]")}>
                {entry.source}
              </span>
            </TableCell>
            <TableCell>{POPULATION_LABELS[entry.population]}</TableCell>
            <TableCell>
              <div className="flex min-w-32 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-14 whitespace-nowrap text-right tabular-nums">
                    {formatPercent(entry.missing_ratio)}
                  </span>
                  <span
                    className="block h-1.5 max-w-full rounded-full bg-[var(--color-accent)] in-data-[affects-evaluation=false]:bg-[var(--color-border-strong)]"
                    role="presentation"
                    style={{ width: `${Math.round((entry.missing_ratio ?? 0) * 100)}%` }}
                  />
                </div>
                <span className={cn(textVariants({ variant: "note" }), "whitespace-nowrap tabular-nums")}>
                  {t("missingOfTotal", { missing: formatCount(entry.missing), total: formatCount(entry.total) })}
                </span>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </tbody>
    </Table>
  );
}

// 「材料」タブ（/admin）から、材料ごとの欠損割合（backend GET /api/admin/material-catalog/
// coverage）を見るパネル。欠損データを取込側で推測して埋めずに、欠損の実態を見えるようにする。
export default function MaterialCoveragePanel() {
  const t = useTranslations("admin.materials");
  const populations = { way: POPULATION_LABELS.way, edge: POPULATION_LABELS.edge };
  return (
    <ReportCard
      title={t("title")}
      info={
        <>
          <p className="m-0 [&+&]:mt-2">{t("info", populations)}</p>
          <p className="m-0 [&+&]:mt-2">{t("infoSource")}</p>
        </>
      }
      load={getMaterialCoverage}
      summary={(report) =>
        t("summary", {
          ...populations,
          wayTotal: formatCount(report.way_total),
          edgeTotal: formatCount(report.edge_total),
        })
      }
    >
      {(report) => <CoverageReport report={report} />}
    </ReportCard>
  );
}

function CoverageSection({ title, hint, entries }: { title: string; hint: string; entries: readonly CountedEntry[] }) {
  return (
    <section className="mt-2 flex flex-col gap-1" aria-label={title}>
      <div className={cn(textVariants({ variant: "body" }), "font-bold")}>{title}</div>
      <p className={textVariants({ variant: "hint" })}>{hint}</p>
      <CoverageTable entries={entries} />
    </section>
  );
}

function CoverageReport({ report }: { report: MaterialCoverageResponse }) {
  const t = useTranslations("admin.materials");
  const covered = sortByMissingRatioDesc(report.materials.filter((m): m is CountedEntry => m.kind === "counted"));
  const excluded = report.materials.filter((m): m is ExcludedEntry => m.kind === "excluded");
  // 集計対象なのにmissing_semanticsがどのグループにも該当しない材料。黙って表から消えると
  // カバレッジ画面が「欠損0件」に見えるため、拾って明示する。
  const ungrouped = covered.filter((entry) => !GROUPED_SEMANTICS.has(entry.missing_semantics));

  return (
    <>
      {vocabulary.materialMissingSemantics.map((group) => {
        const entries = covered.filter((entry) => entry.missing_semantics === group.key);
        if (entries.length === 0) return null;
        return <CoverageSection key={group.key} title={group.title} hint={group.hint} entries={entries} />;
      })}
      {ungrouped.length > 0 && (
        <CoverageSection title={t("ungroupedTitle")} hint={t("ungroupedHint")} entries={ungrouped} />
      )}
      {excluded.length > 0 && (
        <details
          className={cn(
            textVariants({ variant: "hint" }),
            "[&_summary]:cursor-pointer [&_ul]:mt-1 [&_ul]:mb-0 [&_ul]:pl-5",
          )}
        >
          <summary>{t("excluded", { count: String(excluded.length) })}</summary>
          <ul>
            {excluded.map((entry) => (
              <li key={entry.material_id}>
                {t.rich("excludedEntry", {
                  label: entry.label,
                  reason: entry.excluded_reason,
                  name: (chunks) => <span className="text-[var(--foreground)]">{chunks}</span>,
                })}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
