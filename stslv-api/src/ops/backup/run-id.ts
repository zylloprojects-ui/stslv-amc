import { randomBytes } from "node:crypto";

// Identifiers of database backups and document backup runs:
//   <prefix>-<environment>-<UTC time>-<6 random hex characters>
// e.g. stslv-db-production-20261109T021500123Z-3fa9c1
//
// The UTC time carries milliseconds (YYYYMMDDTHHMMSSmmmZ). Identifiers with whole seconds only
// (YYYYMMDDTHHMMSSZ, written before 2026-11-09) stay valid and are read the same way.
//
// "Newest" is ALWAYS decided by the time in the identifier, never by sorting identifiers as text: the random
// suffix says nothing about order, so two runs within the same second used to be ordered by chance, and a
// restore of "latest" could pick an earlier run (found by the document backup test, 2026-11-09).
// Only runs started within the same millisecond share a time; they are then ordered by identifier, which is
// deterministic but arbitrary. The scheduled jobs never overlap (systemd starts the next run only after the
// previous one has ended, and every run takes far longer than a millisecond).

const STAMP = String.raw`(\d{8}T\d{6}(?:\d{3})?Z)`;

export function newRunId(prefix: string, environment: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "");

  return `${prefix}-${environment}-${stamp}-${randomBytes(3).toString("hex")}`;
}

export function runIdPattern(prefix: string): RegExp {
  return new RegExp(`^${prefix}-[a-z0-9-]+-${STAMP}-[0-9a-f]{6}$`);
}

/** The UTC time inside an identifier, or null when the identifier does not have the expected shape. */
export function runIdTime(prefix: string, id: string): Date | null {
  const stamp = runIdPattern(prefix).exec(id)?.[1];

  if (!stamp) return null;

  const ms = stamp.length === 19 ? stamp.slice(15, 18) : "000";
  const time = new Date(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${ms}Z`
  );

  return Number.isNaN(time.getTime()) ? null : time;
}

/** Valid identifiers with their time, newest first. Anything that is not an identifier of this prefix is ignored. */
export function newestFirst(prefix: string, ids: Iterable<string>): { id: string; createdAt: Date }[] {
  const runs: { id: string; createdAt: Date }[] = [];

  for (const id of ids) {
    const createdAt = runIdTime(prefix, id);
    if (createdAt) runs.push({ id, createdAt });
  }

  return runs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}
