// Grandfather-father-son retention for database backups. Default policy (approved requirement): 7 daily,
// 4 weekly, 12 monthly. Periods are counted over the backups that EXIST, newest first, not over the calendar:
// after an outage the last good backups are kept instead of being aged out while no new ones arrive.
// Dates are taken in UTC.

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}

export interface BackupStamp {
  id: string;
  createdAt: Date;
}

export interface RetentionDecision {
  keep: string[];
  remove: string[];
  /** Why each kept backup is kept: "daily", "weekly", "monthly", "newest". */
  reasons: Record<string, string[]>;
}

const dayKey = (date: Date) => date.toISOString().slice(0, 10);
const monthKey = (date: Date) => date.toISOString().slice(0, 7);

/** ISO-8601 week, e.g. "2026-W45". The week belongs to the year of its Thursday. */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = d.getUTCDay() || 7;

  d.setUTCDate(d.getUTCDate() + 4 - weekday);

  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);

  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function selectRetained(backups: readonly BackupStamp[], policy: RetentionPolicy): RetentionDecision {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`Retention ${name} must be a whole number of 0 or more.`);
  }

  const newestFirst = [...backups].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
  const reasons: Record<string, string[]> = {};
  const mark = (id: string, reason: string) => {
    (reasons[id] ??= []).push(reason);
  };
  const keepPerPeriod = (keyOf: (date: Date) => string, count: number, reason: string) => {
    const seen = new Set<string>();

    for (const backup of newestFirst) {
      if (seen.size >= count) break;
      const key = keyOf(backup.createdAt);
      if (seen.has(key)) continue;
      // The newest backup of each period stands for it.
      seen.add(key);
      mark(backup.id, reason);
    }
  };

  if (newestFirst[0]) mark(newestFirst[0].id, "newest");
  keepPerPeriod(dayKey, policy.daily, "daily");
  keepPerPeriod(isoWeekKey, policy.weekly, "weekly");
  keepPerPeriod(monthKey, policy.monthly, "monthly");

  return {
    keep: newestFirst.filter((backup) => reasons[backup.id]).map((backup) => backup.id),
    remove: newestFirst.filter((backup) => !reasons[backup.id]).map((backup) => backup.id),
    reasons,
  };
}
