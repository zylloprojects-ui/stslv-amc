import { randomUUID } from "node:crypto";
import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, notFound } from "../../shared/errors";
import type { AuthContext } from "../auth/access";

export const COUNTRIES = ["OMAN", "QATAR", "BAHRAIN", "KSA", "UAE", "KUWAIT"] as const;
export type Country = (typeof COUNTRIES)[number];

export interface Holiday {
  id: string;
  /** Calendar day, YYYY-MM-DD. */
  date: string;
  name: string;
  isReligious: boolean;
  countries: Country[];
  /** Free text: which divisions the holiday applies to. Null means all of them. */
  divisions: string | null;
}

export type HolidayInput = Omit<Holiday, "id">;

// The holiday list is one JSON document in the existing app_settings table, so it needs no new table.
const KEY = "organization.holidays";
const DESCRIPTION = "Holidays shown in the Settings calendar.";
const MAX_HOLIDAYS = 2000;

function parse(value: string | undefined): Holiday[] {
  if (!value) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);

    return Array.isArray(parsed) ? (parsed as Holiday[]) : [];
  } catch {
    return [];
  }
}

const byDate = (a: Holiday, b: Holiday) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name);
const sameDay = (a: Holiday, b: HolidayInput) => a.date === b.date && a.name.toLowerCase() === b.name.toLowerCase();

export async function listHolidays(): Promise<Holiday[]> {
  const result = await pool.query<{ value: string }>("SELECT value FROM app_settings WHERE key = $1", [KEY]);

  return parse(result.rows[0]?.value).sort(byDate);
}

/** Reads the list under a row lock, lets the caller change it, saves it, and writes the audit entry in the same transaction. */
async function change<T>(
  work: (holidays: Holiday[]) => { holidays: Holiday[]; result: T },
  audit: (client: Queryable, result: T) => Promise<void>
): Promise<T> {
  return withTransaction(async (client) => {
    await client.query("INSERT INTO app_settings (key, value, description) VALUES ($1, '[]', $2) ON CONFLICT (key) DO NOTHING", [KEY, DESCRIPTION]);
    const current = await client.query<{ value: string }>("SELECT value FROM app_settings WHERE key = $1 FOR UPDATE", [KEY]);
    const { holidays, result } = work(parse(current.rows[0]?.value));

    await client.query("UPDATE app_settings SET value = $2 WHERE key = $1", [KEY, JSON.stringify([...holidays].sort(byDate))]);
    await audit(client, result);

    return result;
  });
}

export function createHoliday(auth: AuthContext, input: HolidayInput): Promise<Holiday> {
  return change(
    (holidays) => {
      if (holidays.length >= MAX_HOLIDAYS) {
        throw conflict(`The holiday list is full (${MAX_HOLIDAYS}).`);
      }
      if (holidays.some((existing) => sameDay(existing, input))) {
        throw conflict("This holiday is already on that date.");
      }

      const holiday: Holiday = { id: randomUUID(), ...input };

      return { holidays: [...holidays, holiday], result: holiday };
    },
    (client, holiday) =>
      logActivity(client, {
        userId: auth.user.id,
        action: "holiday.created",
        module: "SETTINGS",
        entityType: "app_settings",
        entityId: null,
        description: `Holiday "${holiday.name}" on ${holiday.date} was added.`,
        metadata: { holidayId: holiday.id, countries: holiday.countries },
      })
  );
}

export function updateHoliday(auth: AuthContext, id: string, input: HolidayInput): Promise<Holiday> {
  return change(
    (holidays) => {
      if (!holidays.some((holiday) => holiday.id === id)) {
        throw notFound("Holiday not found.");
      }
      if (holidays.some((holiday) => holiday.id !== id && sameDay(holiday, input))) {
        throw conflict("This holiday is already on that date.");
      }

      const updated: Holiday = { id, ...input };

      return { holidays: holidays.map((holiday) => (holiday.id === id ? updated : holiday)), result: updated };
    },
    (client, holiday) =>
      logActivity(client, {
        userId: auth.user.id,
        action: "holiday.updated",
        module: "SETTINGS",
        entityType: "app_settings",
        entityId: null,
        description: `Holiday "${holiday.name}" on ${holiday.date} was updated.`,
        metadata: { holidayId: id },
      })
  );
}

export async function deleteHoliday(auth: AuthContext, id: string): Promise<void> {
  await change(
    (holidays) => {
      const found = holidays.find((holiday) => holiday.id === id);

      if (!found) {
        throw notFound("Holiday not found.");
      }

      return { holidays: holidays.filter((holiday) => holiday.id !== id), result: found };
    },
    (client, holiday) =>
      logActivity(client, {
        userId: auth.user.id,
        action: "holiday.deleted",
        module: "SETTINGS",
        entityType: "app_settings",
        entityId: null,
        description: `Holiday "${holiday.name}" on ${holiday.date} was deleted.`,
        metadata: { holidayId: id },
      })
  );
}
