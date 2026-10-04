import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { COUNTRIES, createHoliday, deleteHoliday, listHolidays, updateHoliday } from "./holidays.service";

const isRealDate = (value: string) => {
  const parsed = new Date(`${value}T00:00:00Z`);

  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const holidaySchema = z.strictObject({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date as YYYY-MM-DD.")
    .refine(isRealDate, "This date does not exist."),
  name: z.string().trim().min(1, "Name is required.").max(100, "Name must be at most 100 characters."),
  isReligious: z.boolean(),
  countries: z.array(z.enum(COUNTRIES)).min(1, "Choose at least one country.").max(COUNTRIES.length),
  divisions: z
    .string()
    .trim()
    .max(200, "Divisions must be at most 200 characters.")
    .nullable()
    .optional()
    .transform((value) => (value ? value : null)),
});

const idSchema = z.string().uuid("Holiday not found.");

export const holidaysRouter = Router();

holidaysRouter.use(authenticate);

// The holiday calendar is part of the organisation settings, so the SETTINGS permissions govern it.
holidaysRouter.get("/", authorize("SETTINGS", "VIEW"), async (_req, res) => {
  res.json({ success: true, data: { holidays: await listHolidays(), countries: COUNTRIES } });
});

holidaysRouter.post("/", authorize("SETTINGS", "CREATE"), async (req, res) => {
  res.status(201).json({ success: true, data: await createHoliday(requireAuth(req), holidaySchema.parse(req.body)) });
});

holidaysRouter.put("/:id", authorize("SETTINGS", "EDIT"), async (req, res) => {
  res.json({ success: true, data: await updateHoliday(requireAuth(req), idSchema.parse(req.params.id), holidaySchema.parse(req.body)) });
});

holidaysRouter.delete("/:id", authorize("SETTINGS", "DELETE"), async (req, res) => {
  await deleteHoliday(requireAuth(req), idSchema.parse(req.params.id));
  res.json({ success: true, data: null });
});
