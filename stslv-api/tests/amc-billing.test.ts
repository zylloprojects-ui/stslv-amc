import { describe, expect, it } from "vitest";
import { amountForService, contractYears, expectedTermTotal, positionInCycle, serviceAmounts, servicesPerCycle, subtractMoney } from "../src/modules/amc/amc.billing";
import { buildSchedulePeriods, type ScheduleRule } from "../src/modules/amc/amc.schedule";

const biMonthly: ScheduleRule = { kind: "interval", intervalMonths: 2 };
const halfYearly: ScheduleRule = { kind: "interval", intervalMonths: 6 };
const quarterly: ScheduleRule = { kind: "interval", intervalMonths: 3 };

/** Adds decimal strings in thousandths, the way a person would check the figures. */
const sum = (amounts: string[]) => {
  const total = amounts.reduce((running, amount) => running + BigInt(amount.replace(".", "")), 0n);

  return `${total / 1000n}.${String(total % 1000n).padStart(3, "0")}`;
};

describe("service amounts", () => {
  it("gives the reference's own worked examples", () => {
    expect(serviceAmounts("500.000", 2)).toEqual({ standard: "250.000", last: "250.000", services: 2 });
    expect(serviceAmounts("500.000", 6)).toEqual({ standard: "83.333", last: "83.335", services: 6 });
  });

  it("rounds half up and lets the last service settle the year, up or down", () => {
    // 100 / 6 = 16.666..., rounds up to 16.667, so the last service is lower.
    expect(serviceAmounts("100.000", 6)).toEqual({ standard: "16.667", last: "16.665", services: 6 });
    // 0.002 / 4 = 0.0005, the exact half, rounds up.
    expect(serviceAmounts("0.002", 4).standard).toBe("0.001");
  });

  it.each([
    ["500.000", 6],
    ["1000.001", 12],
    ["0.007", 3],
    ["99999.999", 7],
    ["250.500", 4],
  ])("a complete cycle of %s across %i adds up exactly", (annual, services) => {
    const { standard, last } = serviceAmounts(annual, services);

    expect(sum([...Array<string>(services - 1).fill(standard), last])).toBe(Number(annual).toFixed(3));
  });

  it("rejects values that are not money, and cycles with no service", () => {
    expect(() => serviceAmounts("abc", 2)).toThrow();
    expect(() => serviceAmounts("1.2345", 2)).toThrow();
    expect(() => serviceAmounts("100.000", 0)).toThrow();
  });
});

describe("position in the annual cycle", () => {
  it("counts from the contract start, restarting every year", () => {
    expect(positionInCycle("2026-10-24", biMonthly, "2026-10-24")).toBe(1);
    expect(positionInCycle("2026-10-24", biMonthly, "2027-08-24")).toBe(6);
    expect(positionInCycle("2026-10-24", biMonthly, "2027-10-24")).toBe(1);
  });

  it("handles custom months, whichever month the contract starts in", () => {
    const rule: ScheduleRule = { kind: "months", months: [2, 5, 8] };

    expect(servicesPerCycle(rule)).toBe(3);
    expect(positionInCycle("2027-06-01", rule, "2027-08-01")).toBe(1);
    expect(positionInCycle("2027-06-01", rule, "2028-02-01")).toBe(2);
    expect(positionInCycle("2027-06-01", rule, "2028-05-01")).toBe(3);
  });

  it("is null off the rule, so such a visit never takes the remainder", () => {
    expect(positionInCycle("2027-01-01", quarterly, "2027-02-01")).toBeNull();
    expect(positionInCycle("2027-01-01", quarterly, "2026-12-01")).toBeNull();
    expect(amountForService("100.000", "2027-01-01", { kind: "interval", intervalMonths: 3 }, "2027-02-01")).toBe("25.000");
  });
});

describe("multi-year terms", () => {
  it("AMC-3: 4 years bi-monthly at 500.000 a year is 24 services totalling 2,000.000", () => {
    const periods = buildSchedulePeriods("2026-10-24", "2030-10-23", biMonthly);
    const amounts = periods.map((period) => amountForService("500.000", "2026-10-24", biMonthly, period.periodStart));

    expect(amounts).toHaveLength(24);
    expect(amounts.filter((amount) => amount === "83.335")).toHaveLength(4);
    expect(amounts.filter((amount) => amount === "83.333")).toHaveLength(20);
    expect(sum(amounts)).toBe("2000.000");
    expect(expectedTermTotal("500.000", "2026-10-24", "2030-10-23", biMonthly, null)).toBe("2000.000");
  });

  it("every year repeats the annual amount: it is never spread across the term", () => {
    const amounts = buildSchedulePeriods("2027-01-01", "2028-12-31", biMonthly).map((period) => amountForService("500.000", "2027-01-01", biMonthly, period.periodStart));

    expect(sum(amounts.slice(0, 6))).toBe("500.000");
    expect(sum(amounts.slice(6, 12))).toBe("500.000");
  });

  it("a partial year is not prorated: standard amount, no remainder", () => {
    // 18 months half-yearly: 3 x 250.000.
    expect(expectedTermTotal("500.000", "2027-01-01", "2028-06-30", halfYearly, null)).toBe("750.000");
    // 18 months bi-monthly: year 1 complete (500.000), then 3 x 83.333 with no last service.
    const amounts = buildSchedulePeriods("2027-01-01", "2028-06-30", biMonthly).map((period) => amountForService("500.000", "2027-01-01", biMonthly, period.periodStart));

    expect(amounts).toHaveLength(9);
    expect(amounts.slice(6)).toEqual(["83.333", "83.333", "83.333"]);
    expect(expectedTermTotal("500.000", "2027-01-01", "2028-06-30", biMonthly, null)).toBe("749.999");
  });

  it("an imported contract counts only the periods from its cutover", () => {
    expect(expectedTermTotal("400.000", "2027-01-01", "2027-12-31", quarterly, "2027-07-01")).toBe("200.000");
  });

  it("counts a part year as a contract year", () => {
    expect(contractYears("2027-01-01", "2027-12-31")).toBe(1);
    expect(contractYears("2027-01-01", "2028-01-01")).toBe(2);
    expect(contractYears("2026-10-24", "2030-10-23")).toBe(4);
  });
});

describe("subtractMoney", () => {
  it("is exact and can be negative", () => {
    expect(subtractMoney("500.000", "499.998")).toBe("0.002");
    expect(subtractMoney("100.000", "100.000")).toBe("0.000");
    expect(subtractMoney("1.000", "1.500")).toBe("-0.500");
  });
});
