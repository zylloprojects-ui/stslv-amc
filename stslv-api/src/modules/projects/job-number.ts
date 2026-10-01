import type { PoolClient } from "pg";
import type { Queryable } from "../../shared/db";

// PROVISIONAL (open question Q6). The format of a Job Number is data held in
// number_sequences (prefix, next number, zero-padding), not code. The seeded
// values follow the pattern seen in the legacy register; the client has not
// confirmed them as the future rule. This file is the only place that
// produces a Job Number, so a confirmed rule changes one function.

const SEQUENCE_KEY = "job_number";

// A run of numbers this long already in use means the counter is misconfigured.
const MAX_SKIPS = 10_000;

interface SequenceRow {
  prefix: string;
  next_number: string;
  pad_length: number;
}

export function formatJobNumber(prefix: string, number: bigint, padLength: number): string {
  return `${prefix}${number.toString().padStart(padLength, "0")}`;
}

async function readSequence(db: Queryable, lock: boolean): Promise<SequenceRow> {
  const result = await db.query<SequenceRow>(
    `SELECT prefix, next_number, pad_length FROM number_sequences WHERE sequence_key = $1${lock ? " FOR UPDATE" : ""}`,
    [SEQUENCE_KEY]
  );
  const row = result.rows[0];

  if (!row) {
    throw new Error('The "job_number" row is missing from number_sequences.');
  }

  return row;
}

/** First number at or after the counter that no project uses yet. */
async function firstUnused(db: Queryable, sequence: SequenceRow): Promise<{ number: bigint; jobNumber: string }> {
  let number = BigInt(sequence.next_number);

  for (let skipped = 0; skipped < MAX_SKIPS; skipped += 1) {
    const jobNumber = formatJobNumber(sequence.prefix, number, sequence.pad_length);
    const taken = await db.query("SELECT 1 FROM projects WHERE job_number = $1", [jobNumber]);

    if (taken.rowCount === 0) {
      return { number, jobNumber };
    }

    number += 1n;
  }

  throw new Error("No unused job number was found. Check the job_number row in number_sequences.");
}

/**
 * Issues the next Job Number. Must run inside the transaction that inserts
 * the project:
 * - the counter row is locked, so two projects created at the same moment
 *   cannot receive the same number;
 * - if the insert fails, the transaction rolls back and the number is not used up;
 * - a number already held by a project (for example an imported legacy job)
 *   is skipped, never reused.
 * The UNIQUE constraint on projects.job_number remains the final safeguard.
 */
export async function generateJobNumber(client: PoolClient): Promise<string> {
  const sequence = await readSequence(client, true);
  const { number, jobNumber } = await firstUnused(client, sequence);

  await client.query("UPDATE number_sequences SET next_number = $1 WHERE sequence_key = $2", [
    (number + 1n).toString(),
    SEQUENCE_KEY,
  ]);

  return jobNumber;
}

/** The number the next project would receive. Shown for information only; nothing is reserved. */
export async function previewNextJobNumber(db: Queryable): Promise<string> {
  return (await firstUnused(db, await readSequence(db, false))).jobNumber;
}
