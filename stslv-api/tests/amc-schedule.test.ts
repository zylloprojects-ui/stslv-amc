import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  buildSchedulePeriods,
  isValidIsoDate,
  planSchedule,
  type ExistingVisit,
} from "../src/modules/amc/amc.schedule";

// Pure schedule arithmetic: no database is involved in this file.

const starts = (...args: Parameters<typeof buildSchedulePeriods>) =>
  buildSchedulePeriods(...args).map((period) => period.periodStart);

function visit(periodStart: string, periodEnd: string, overrides: Partial<ExistingVisit> = {}): ExistingVisit {
  return {
    id: periodStart,
    sequenceNo: 1,
    periodStart,
    periodEnd,
    scheduledDate: periodStart,
    status: "SCHEDULED",
    locked: false,
    ...overrides,
  };
}

describe("date helpers", () => {
  it("accepts only real calendar days", () => {
    expect(isValidIsoDate("2028-02-29")).toBe(true);
    expect(isValidIsoDate("2027-02-29")).toBe(false);
    expect(isValidIsoDate("2027-02-30")).toBe(false);
    expect(isValidIsoDate("2027-13-01")).toBe(false);
    expect(isValidIsoDate("27-01-01")).toBe(false);
    expect(isValidIsoDate("2027-1-1")).toBe(false);
  });

  it("adds months, using the last day of a shorter month", () => {
    expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2027-11-15", 3)).toBe("2028-02-15");
    expect(addMonths("2027-03-31", -1)).toBe("2027-02-28");
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2027-12-31", 1)).toBe("2028-01-01");
    expect(addDays("2027-03-01", -1)).toBe("2027-02-28");
  });
});

describe("periods by frequency", () => {
  it.each([
    ["MONTHLY", 12],
    ["QUARTERLY", 4],
    ["HALF_YEARLY", 2],
    ["ANNUALLY", 1],
  ] as const)("%s gives %i visits in a one-year contract", (frequency, count) => {
    expect(buildSchedulePeriods("2026-07-01", "2027-06-30", frequency)).toHaveLength(count);
  });

  it.each([
    ["MONTHLY", 60],
    ["QUARTERLY", 20],
    ["HALF_YEARLY", 10],
    ["ANNUALLY", 5],
  ] as const)("%s gives %i visits in a five-year contract", (frequency, count) => {
    expect(buildSchedulePeriods("2027-01-01", "2031-12-31", frequency)).toHaveLength(count);
  });

  it("gives each quarterly visit its own dated period", () => {
    expect(buildSchedulePeriods("2026-07-01", "2027-06-30", "QUARTERLY")).toEqual([
      { periodStart: "2026-07-01", periodEnd: "2026-09-30", scheduledDate: "2026-07-01" },
      { periodStart: "2026-10-01", periodEnd: "2026-12-31", scheduledDate: "2026-10-01" },
      { periodStart: "2027-01-01", periodEnd: "2027-03-31", scheduledDate: "2027-01-01" },
      { periodStart: "2027-04-01", periodEnd: "2027-06-30", scheduledDate: "2027-04-01" },
    ]);
  });

  it("leaves no gap and no overlap between periods", () => {
    const periods = buildSchedulePeriods("2027-01-31", "2029-01-30", "MONTHLY");

    for (let index = 1; index < periods.length; index += 1) {
      expect(periods[index]?.periodStart).toBe(addDays(periods[index - 1]?.periodEnd as string, 1));
    }
    expect(periods[0]?.periodStart).toBe("2027-01-31");
    expect(periods.at(-1)?.periodEnd).toBe("2029-01-30");
  });

  it("counts every period from the contract start, so month-end dates do not drift", () => {
    expect(starts("2027-01-31", "2027-06-30", "MONTHLY")).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
      "2027-06-30",
    ]);
  });
});

describe("contract date boundaries", () => {
  it("never starts a period after the validity ends", () => {
    // The day before the second quarter would start.
    expect(starts("2027-01-01", "2027-03-31", "QUARTERLY")).toEqual(["2027-01-01"]);
    // Annual contract one day short of two years: the second year still starts inside.
    expect(starts("2027-01-01", "2028-12-30", "ANNUALLY")).toEqual(["2027-01-01", "2028-01-01"]);
  });

  it("includes a period that starts exactly on the last day", () => {
    expect(buildSchedulePeriods("2027-01-01", "2027-04-01", "QUARTERLY")).toEqual([
      { periodStart: "2027-01-01", periodEnd: "2027-03-31", scheduledDate: "2027-01-01" },
      { periodStart: "2027-04-01", periodEnd: "2027-04-01", scheduledDate: "2027-04-01" },
    ]);
  });

  it("ends a short final period on the last day of validity", () => {
    const periods = buildSchedulePeriods("2027-01-01", "2027-11-15", "QUARTERLY");

    expect(periods).toHaveLength(4);
    expect(periods.at(-1)).toEqual({ periodStart: "2027-10-01", periodEnd: "2027-11-15", scheduledDate: "2027-10-01" });
  });

  it("gives a one-day contract exactly one visit", () => {
    expect(buildSchedulePeriods("2027-05-10", "2027-05-10", "MONTHLY")).toEqual([
      { periodStart: "2027-05-10", periodEnd: "2027-05-10", scheduledDate: "2027-05-10" },
    ]);
  });
});

describe("import cutover date", () => {
  // A July-to-June contract, quarterly.
  const all = ["2025-07-01", "2025-10-01", "2026-01-01", "2026-04-01"];

  it("changes nothing when there is none", () => {
    expect(starts("2025-07-01", "2026-06-30", "QUARTERLY")).toEqual(all);
    expect(starts("2025-07-01", "2026-06-30", "QUARTERLY", null)).toEqual(all);
  });

  it("returns only the periods that start on or after it", () => {
    expect(starts("2025-07-01", "2026-06-30", "QUARTERLY", "2025-11-15")).toEqual(["2026-01-01", "2026-04-01"]);
    // A period in progress on the cutover date started before it: it is history.
    expect(starts("2025-07-01", "2026-06-30", "QUARTERLY", "2026-04-02")).toEqual([]);
  });

  it("includes a period that starts exactly on it", () => {
    expect(starts("2025-07-01", "2026-06-30", "QUARTERLY", "2026-01-01")).toEqual(["2026-01-01", "2026-04-01"]);
  });

  it("has no effect before the contract starts, and leaves nothing once the last period has started", () => {
    expect(starts("2025-07-01", "2026-06-30", "QUARTERLY", "2025-01-01")).toEqual(all);
    expect(starts("2025-07-01", "2026-06-30", "QUARTERLY", "2026-10-01")).toEqual([]);
  });

  it("keeps the later periods on the dates they would have had anyway", () => {
    const full = buildSchedulePeriods("2027-01-31", "2027-06-30", "MONTHLY");

    // 31 Jan and 28 Feb are before the cutover; 31 Mar onwards is not.
    expect(buildSchedulePeriods("2027-01-31", "2027-06-30", "MONTHLY", "2027-03-15")).toEqual(full.slice(2));
    expect(full[2]?.periodStart).toBe("2027-03-31");
  });

  it("plans no visit for a period before it, and keeps the historical visits that exist", () => {
    const periods = buildSchedulePeriods("2025-07-01", "2026-06-30", "QUARTERLY", "2026-01-01");
    // The source listed only the second period.
    const historical = [visit("2025-10-01", "2025-12-31", { status: "HISTORICAL", locked: true })];
    const plan = planSchedule(periods, historical, "2025-07-01", "2026-06-30");

    expect(plan.toCreate.map((period) => period.periodStart)).toEqual(["2026-01-01", "2026-04-01"]);
    expect(plan.kept).toEqual(historical);
    expect(plan.toRemove).toEqual([]);
    expect(plan.blocking).toEqual([]);
  });
});

describe("schedule plan", () => {
  const quarterly = buildSchedulePeriods("2027-01-01", "2027-12-31", "QUARTERLY");
  const existing = quarterly.map((period) => visit(period.periodStart, period.periodEnd));

  it("creates every visit for a contract that has none", () => {
    const plan = planSchedule(quarterly, [], "2027-01-01", "2027-12-31");

    expect(plan.toCreate).toEqual(quarterly);
    expect(plan.toRemove).toEqual([]);
  });

  it("changes nothing when the visits already match", () => {
    const plan = planSchedule(quarterly, existing, "2027-01-01", "2027-12-31");

    expect(plan.toCreate).toEqual([]);
    expect(plan.toRemove).toEqual([]);
    expect(plan.kept).toHaveLength(4);
  });

  it("adds only the new periods when the validity is extended", () => {
    const longer = buildSchedulePeriods("2027-01-01", "2028-06-30", "QUARTERLY");
    const plan = planSchedule(longer, existing, "2027-01-01", "2028-06-30");

    expect(plan.toCreate.map((period) => period.periodStart)).toEqual(["2028-01-01", "2028-04-01"]);
    expect(plan.toRemove).toEqual([]);
  });

  it("removes untouched visits beyond a shortened validity", () => {
    const shorter = buildSchedulePeriods("2027-01-01", "2027-06-30", "QUARTERLY");
    const plan = planSchedule(shorter, existing, "2027-01-01", "2027-06-30");

    expect(plan.toRemove.map((item) => item.periodStart)).toEqual(["2027-07-01", "2027-10-01"]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.blocking).toEqual([]);
  });

  it("reports a worked-on visit outside the new validity instead of removing it", () => {
    const withCompleted = existing.map((item) =>
      item.periodStart === "2027-10-01" ? { ...item, status: "COMPLETED" as const, locked: true } : item
    );
    const shorter = buildSchedulePeriods("2027-01-01", "2027-06-30", "QUARTERLY");
    const plan = planSchedule(shorter, withCompleted, "2027-01-01", "2027-06-30");

    expect(plan.blocking.map((item) => item.periodStart)).toEqual(["2027-10-01"]);
    expect(plan.toRemove.map((item) => item.periodStart)).toEqual(["2027-07-01"]);
  });

  it("does not let a cancelled visit outside the validity block a change", () => {
    const withCancelled = existing.map((item) =>
      item.periodStart === "2027-10-01" ? { ...item, status: "CANCELLED" as const, locked: true } : item
    );
    const shorter = buildSchedulePeriods("2027-01-01", "2027-06-30", "QUARTERLY");

    expect(planSchedule(shorter, withCancelled, "2027-01-01", "2027-06-30").blocking).toEqual([]);
  });

  it("does not recreate a period whose visit was cancelled", () => {
    const withCancelled = existing.map((item) =>
      item.periodStart === "2027-04-01" ? { ...item, status: "CANCELLED" as const, locked: true } : item
    );
    const plan = planSchedule(quarterly, withCancelled, "2027-01-01", "2027-12-31");

    expect(plan.toCreate).toEqual([]);
  });

  it("keeps worked-on visits and does not schedule their period twice when the frequency changes", () => {
    // Quarterly contract, first quarter completed, then changed to monthly.
    const withCompleted = existing.map((item) =>
      item.periodStart === "2027-01-01" ? { ...item, status: "COMPLETED" as const, locked: true } : item
    );
    const monthly = buildSchedulePeriods("2027-01-01", "2027-12-31", "MONTHLY");
    const plan = planSchedule(monthly, withCompleted, "2027-01-01", "2027-12-31");

    expect(plan.kept.map((item) => item.periodStart)).toEqual(["2027-01-01"]);
    expect(plan.toRemove.map((item) => item.periodStart)).toEqual(["2027-04-01", "2027-07-01", "2027-10-01"]);
    // January is already covered by the completed visit.
    expect(plan.toCreate.map((period) => period.periodStart)).toEqual([
      "2027-02-01",
      "2027-03-01",
      "2027-04-01",
      "2027-05-01",
      "2027-06-01",
      "2027-07-01",
      "2027-08-01",
      "2027-09-01",
      "2027-10-01",
      "2027-11-01",
      "2027-12-01",
    ]);
  });
});
