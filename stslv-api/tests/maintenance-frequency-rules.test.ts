import { describe, expect, it } from "vitest";
import {
  describeRule,
  engineSupports,
  lockedChanges,
  normalizeCode,
  normalizePrefix,
  ruleProblems,
  statusOf,
} from "../src/modules/masters/maintenance-frequencies.rules";
import {
  createFrequencySchema,
  frequencyStatusSchema,
  listFrequenciesSchema,
  updateFrequencySchema,
} from "../src/modules/masters/maintenance-frequencies.schemas";

// The maintenance frequency rules and form validation. Pure: no database, so
// these run without migration 0076.

// The seven reference definitions (test fixtures; 0076 seeds the same values).
const REFERENCE = [
  { code: "MONTHLY", name: "Monthly", serviceCount: 12, intervalMonths: 1, codePrefix: "M", isCustom: false },
  { code: "QUARTERLY", name: "Quarterly", serviceCount: 4, intervalMonths: 3, codePrefix: "Q", isCustom: false },
  { code: "HALF_YEARLY", name: "Half Yearly", serviceCount: 2, intervalMonths: 6, codePrefix: "H", isCustom: false },
  { code: "ANNUALLY", name: "Annually", serviceCount: 1, intervalMonths: 12, codePrefix: "A", isCustom: false },
  { code: "BI_MONTHLY", name: "Bi-Monthly / Every 2 Months", serviceCount: 6, intervalMonths: 2, codePrefix: "BM", isCustom: false },
  { code: "EVERY_4_MONTHS", name: "Every 4 Months", serviceCount: 3, intervalMonths: 4, codePrefix: "T", isCustom: false },
  { code: "CUSTOM", name: "Custom", serviceCount: null, intervalMonths: null, codePrefix: "C", isCustom: true },
];

const fieldsOf = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  (result.error?.issues ?? []).map((issue) => issue.path.join("."));

describe("fixed-interval rules", () => {
  it("accepts every reference definition", () => {
    for (const rule of REFERENCE) {
      expect(ruleProblems(rule), rule.code).toEqual([]);
      expect(createFrequencySchema.safeParse(rule).success, rule.code).toBe(true);
    }
  });

  it("accepts every interval that divides the year, with the matching service count", () => {
    for (const interval of [1, 2, 3, 4, 6, 12]) {
      expect(ruleProblems({ isCustom: false, serviceCount: 12 / interval, intervalMonths: interval })).toEqual([]);
    }
  });

  it("rejects intervals that do not divide the year", () => {
    for (const interval of [5, 7, 8, 9, 10, 11]) {
      const problems = ruleProblems({ isCustom: false, serviceCount: 1, intervalMonths: interval });
      expect(problems.map((problem) => problem.field), String(interval)).toContain("intervalMonths");
    }
  });

  it("rejects a service count that does not match the interval, and says what it should be", () => {
    const problems = ruleProblems({ isCustom: false, serviceCount: 3, intervalMonths: 3 });

    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe("serviceCount");
    expect(problems[0]?.message).toContain("services per year is 4");
  });

  it("requires both numbers in fixed mode", () => {
    expect(ruleProblems({ isCustom: false, serviceCount: null, intervalMonths: null }).map((problem) => problem.field).sort()).toEqual([
      "intervalMonths",
      "serviceCount",
    ]);
    expect(fieldsOf(createFrequencySchema.safeParse({ name: "Odd", code: "ODD", codePrefix: "O" }))).toEqual(
      expect.arrayContaining(["intervalMonths", "serviceCount"])
    );
  });

  it("rejects non-integer, zero and out-of-range numbers at the form", () => {
    for (const bad of [0, -1, 1.5, 13, "3"]) {
      const result = createFrequencySchema.safeParse({ name: "X", code: "XX", codePrefix: "X", serviceCount: 4, intervalMonths: bad });
      expect(fieldsOf(result), String(bad)).toContain("intervalMonths");
    }
  });
});

describe("custom month-selection mode", () => {
  it("stores no services per year and no interval", () => {
    const parsed = createFrequencySchema.parse({ name: "Custom", code: "custom", codePrefix: "c", isCustom: true });

    expect(parsed).toMatchObject({ isCustom: true, serviceCount: null, intervalMonths: null, code: "CUSTOM", codePrefix: "C" });
  });

  it("refuses stale fixed-interval numbers sent with custom mode", () => {
    const result = createFrequencySchema.safeParse({ name: "Custom", code: "CUSTOM", codePrefix: "C", isCustom: true, serviceCount: 4, intervalMonths: 3 });

    expect(fieldsOf(result).sort()).toEqual(["intervalMonths", "serviceCount"]);
  });

  it("is supported by the schedule engine (migration 0076; the custom rule itself is provisional)", () => {
    expect(engineSupports({ isCustom: true, serviceCount: null, intervalMonths: null })).toBe(true);
  });
});

describe("schedule engine support", () => {
  it("covers all seven reference rules", () => {
    expect(REFERENCE.filter((rule) => engineSupports(rule)).map((rule) => rule.code)).toEqual(REFERENCE.map((rule) => rule.code));
  });

  it("does not cover an inconsistent rule", () => {
    expect(engineSupports({ isCustom: false, serviceCount: 3, intervalMonths: 3 })).toBe(false);
    expect(engineSupports({ isCustom: false, serviceCount: 2, intervalMonths: 5 })).toBe(false);
  });
});

describe("codes and prefixes", () => {
  it("normalises codes to upper case with underscores", () => {
    expect(normalizeCode("  every 4-months ")).toBe("EVERY_4_MONTHS");
    expect(normalizeCode("half-yearly")).toBe("HALF_YEARLY");
    expect(normalizePrefix(" bm ")).toBe("BM");
  });

  it("rejects codes and prefixes outside the allowed characters", () => {
    for (const code of ["4_MONTHS", "A", "BAD!CODE", "", "X".repeat(31)]) {
      expect(fieldsOf(createFrequencySchema.safeParse({ ...REFERENCE[0], code })), code).toContain("code");
    }
    for (const codePrefix of ["", "Q1", "ABCDE", "B-M"]) {
      expect(fieldsOf(createFrequencySchema.safeParse({ ...REFERENCE[0], codePrefix })), codePrefix).toContain("codePrefix");
    }
  });

  it("has a unique prefix for every reference frequency (no shared S)", () => {
    const prefixes = REFERENCE.map((rule) => rule.codePrefix);

    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe("locked fields", () => {
  const base = { code: "QUARTERLY", isCustom: false, serviceCount: 4, intervalMonths: 3, codePrefix: "Q" };

  it("lists each scheduling field an edit would change", () => {
    expect(lockedChanges(base, { ...base })).toEqual([]);
    expect(lockedChanges(base, { ...base, codePrefix: "QQ", intervalMonths: 6, serviceCount: 2 })).toEqual(["serviceCount", "intervalMonths", "codePrefix"]);
    expect(lockedChanges(base, { ...base, code: "QTR" })).toEqual(["code"]);
  });
});

describe("statuses and other schemas", () => {
  it("derives Active, Disabled and Archived from the stored flags", () => {
    expect(statusOf({ isActive: true, archivedAt: null })).toBe("active");
    expect(statusOf({ isActive: false, archivedAt: null })).toBe("disabled");
    expect(statusOf({ isActive: false, archivedAt: "2026-10-27T00:00:00.000Z" })).toBe("archived");
  });

  it("does not let a new frequency start archived", () => {
    expect(fieldsOf(createFrequencySchema.safeParse({ ...REFERENCE[0], status: "archived" }))).toEqual(["status"]);
  });

  it("accepts the three statuses and an optional confirmation", () => {
    expect(frequencyStatusSchema.parse({ status: "archived", confirm: true })).toEqual({ status: "archived", confirm: true });
    expect(frequencyStatusSchema.safeParse({ status: "deleted" }).success).toBe(false);
    expect(frequencyStatusSchema.safeParse({ isActive: false }).success).toBe(false);
  });

  it("lists active and disabled frequencies by default", () => {
    expect(listFrequenciesSchema.parse({})).toMatchObject({ status: "current", direction: "asc", page: 1, pageSize: 25 });
  });

  it("needs at least one field on edit and rejects unknown fields", () => {
    expect(updateFrequencySchema.safeParse({}).success).toBe(false);
    expect(updateFrequencySchema.safeParse({ isActive: false }).success).toBe(false);
    expect(updateFrequencySchema.parse({ name: " Quarterly service " })).toEqual({ name: "Quarterly service" });
  });

  it("describes a rule in words", () => {
    expect(describeRule(REFERENCE[1] as (typeof REFERENCE)[number])).toBe("4 services · every 3 months");
    expect(describeRule(REFERENCE[3] as (typeof REFERENCE)[number])).toBe("1 service · every 12 months");
    expect(describeRule(REFERENCE[0] as (typeof REFERENCE)[number])).toBe("12 services · every month");
    expect(describeRule(REFERENCE[6] as (typeof REFERENCE)[number])).toBe("Months chosen on each contract");
  });
});
