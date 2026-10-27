import { describe, expect, it } from "vitest";
import { FREQUENCY_MONTHS, MAINTENANCE_FREQUENCIES } from "../src/modules/amc/amc.constants";
import { addDays, addMonths, buildSchedulePeriods, serviceLabel, type ScheduleRule } from "../src/modules/amc/amc.schedule";

// The schedule engine with frequency rules (migration 0076): fixed intervals
// from the frequency master, custom months, and service labels. Pure: no
// database. The four built-in codes are covered by amc-schedule.test.ts; here
// they are checked again to give identical periods through the rule path.

const interval = (intervalMonths: number): ScheduleRule => ({ kind: "interval", intervalMonths });
const months = (...list: number[]): ScheduleRule => ({ kind: "months", months: list });
const starts = (validFrom: string, validTo: string, rule: ScheduleRule, cutover: string | null = null) =>
  buildSchedulePeriods(validFrom, validTo, rule, cutover).map((period) => period.periodStart);

describe("existing four frequencies", () => {
  // Start dates that exercise month ends, leap years and year ends.
  const STARTS = ["2026-01-01", "2026-01-31", "2026-02-28", "2027-02-28", "2028-02-29", "2026-03-31", "2026-08-31", "2026-11-30", "2026-12-31", "2026-07-15"];

  it("gives identical periods through the rule path as through the built-in code", () => {
    for (const code of MAINTENANCE_FREQUENCIES) {
      for (const validFrom of STARTS) {
        for (const years of [1, 3, 5]) {
          const validTo = addDays(addMonths(validFrom, years * 12), -1);

          expect(buildSchedulePeriods(validFrom, validTo, interval(FREQUENCY_MONTHS[code])), `${code} ${validFrom} ${years}y`).toEqual(
            buildSchedulePeriods(validFrom, validTo, code)
          );
        }
      }
    }
  });

  it("keeps cutover handling identical", () => {
    expect(buildSchedulePeriods("2026-01-01", "2027-12-31", interval(3), "2026-08-15")).toEqual(
      buildSchedulePeriods("2026-01-01", "2027-12-31", "QUARTERLY", "2026-08-15")
    );
  });
});

describe("new fixed intervals", () => {
  it("bi-monthly: six visits a year, every two months", () => {
    expect(starts("2027-01-01", "2027-12-31", interval(2))).toEqual(["2027-01-01", "2027-03-01", "2027-05-01", "2027-07-01", "2027-09-01", "2027-11-01"]);
  });

  it("every four months: three visits a year", () => {
    const periods = buildSchedulePeriods("2027-01-01", "2027-12-31", interval(4));

    expect(periods).toEqual([
      { periodStart: "2027-01-01", periodEnd: "2027-04-30", scheduledDate: "2027-01-01" },
      { periodStart: "2027-05-01", periodEnd: "2027-08-31", scheduledDate: "2027-05-01" },
      { periodStart: "2027-09-01", periodEnd: "2027-12-31", scheduledDate: "2027-09-01" },
    ]);
  });

  it("counts every visit from the contract start, so month ends do not drift", () => {
    expect(starts("2027-01-31", "2028-01-30", interval(2))).toEqual(["2027-01-31", "2027-03-31", "2027-05-31", "2027-07-31", "2027-09-30", "2027-11-30"]);
    expect(starts("2027-10-31", "2028-10-30", interval(4))).toEqual(["2027-10-31", "2028-02-29", "2028-06-30"]);
  });

  it("covers a five-year contract", () => {
    expect(starts("2027-01-01", "2031-12-31", interval(2))).toHaveLength(30);
    expect(starts("2027-01-01", "2031-12-31", interval(4))).toHaveLength(15);
  });
});

describe("custom months (PROVISIONAL rule)", () => {
  it("schedules one visit in each selected month, on the contract start day", () => {
    const periods = buildSchedulePeriods("2027-01-15", "2028-01-14", months(2, 5, 8, 11));

    expect(periods).toEqual([
      { periodStart: "2027-02-15", periodEnd: "2027-05-14", scheduledDate: "2027-02-15" },
      { periodStart: "2027-05-15", periodEnd: "2027-08-14", scheduledDate: "2027-05-15" },
      { periodStart: "2027-08-15", periodEnd: "2027-11-14", scheduledDate: "2027-08-15" },
      { periodStart: "2027-11-15", periodEnd: "2028-01-14", scheduledDate: "2027-11-15" },
    ]);
  });

  it("orders the months by the contract year, which may start mid-year, and ignores the order given", () => {
    expect(starts("2027-07-01", "2028-06-30", months(9, 3))).toEqual(["2027-09-01", "2028-03-01"]);
    expect(starts("2027-07-01", "2028-06-30", months(3, 9))).toEqual(["2027-09-01", "2028-03-01"]);
  });

  it("includes the start month itself when it is selected", () => {
    expect(starts("2027-03-10", "2028-03-09", months(3, 9))).toEqual(["2027-03-10", "2027-09-10"]);
  });

  it("clamps to the month end without drifting", () => {
    expect(starts("2027-01-31", "2029-01-30", months(2, 4, 6))).toEqual([
      "2027-02-28",
      "2027-04-30",
      "2027-06-30",
      "2028-02-29",
      "2028-04-30",
      "2028-06-30",
    ]);
  });

  it("respects the validity: nothing after valid to, and a short last period ends on valid to", () => {
    const periods = buildSchedulePeriods("2027-01-01", "2027-08-20", months(2, 5, 8, 11));

    expect(periods.map((period) => period.periodStart)).toEqual(["2027-02-01", "2027-05-01", "2027-08-01"]);
    expect(periods.at(-1)?.periodEnd).toBe("2027-08-20");
  });

  it("repeats every contract year for multi-year contracts", () => {
    expect(starts("2027-01-01", "2031-12-31", months(2, 5, 8, 11))).toHaveLength(20);
  });

  it("applies a cutover date like the fixed rules", () => {
    expect(starts("2027-01-01", "2027-12-31", months(2, 5, 8, 11), "2027-06-01")).toEqual(["2027-08-01", "2027-11-01"]);
  });

  it("refuses an empty or invalid month list", () => {
    expect(() => buildSchedulePeriods("2027-01-01", "2027-12-31", months())).toThrow();
    expect(() => buildSchedulePeriods("2027-01-01", "2027-12-31", months(13))).toThrow();
    expect(() => buildSchedulePeriods("2027-01-01", "2027-12-31", interval(0))).toThrow();
  });
});

describe("service labels", () => {
  const labels = (validFrom: string, validTo: string, rule: ScheduleRule, prefix: string) =>
    buildSchedulePeriods(validFrom, validTo, rule).map((period) => {
      const label = serviceLabel(validFrom, rule, prefix, period.periodStart);
      return `Y${label.cycleNo}-${label.serviceCode}`;
    });

  it("numbers quarterly visits Q1-Q4 within each contract year", () => {
    expect(labels("2027-04-01", "2029-03-31", interval(3), "Q")).toEqual(["Y1-Q1", "Y1-Q2", "Y1-Q3", "Y1-Q4", "Y2-Q1", "Y2-Q2", "Y2-Q3", "Y2-Q4"]);
  });

  it("labels each frequency with its own prefix and count", () => {
    expect(labels("2027-01-01", "2027-12-31", interval(1), "M").at(-1)).toBe("Y1-M12");
    expect(labels("2027-01-01", "2027-12-31", interval(2), "BM")).toEqual(["Y1-BM1", "Y1-BM2", "Y1-BM3", "Y1-BM4", "Y1-BM5", "Y1-BM6"]);
    expect(labels("2027-01-01", "2027-12-31", interval(4), "T")).toEqual(["Y1-T1", "Y1-T2", "Y1-T3"]);
    expect(labels("2027-01-01", "2028-12-31", interval(6), "H")).toEqual(["Y1-H1", "Y1-H2", "Y2-H1", "Y2-H2"]);
    expect(labels("2027-01-01", "2029-12-31", interval(12), "A")).toEqual(["Y1-A1", "Y2-A1", "Y3-A1"]);
  });

  it("numbers custom visits by their place in the contract year", () => {
    expect(labels("2027-07-01", "2029-06-30", months(9, 3), "C")).toEqual(["Y1-C1", "Y1-C2", "Y2-C1", "Y2-C2"]);
  });

  it("keeps labels on month-end dates", () => {
    expect(labels("2027-01-31", "2028-01-30", interval(3), "Q")).toEqual(["Y1-Q1", "Y1-Q2", "Y1-Q3", "Y1-Q4"]);
  });

  it("matches the database format for service codes", () => {
    for (const code of labels("2027-01-01", "2031-12-31", interval(1), "BMXY")) {
      expect(code.split("-")[1]).toMatch(/^[A-Z]{1,4}[1-9][0-9]{0,2}$/);
    }
  });
});
