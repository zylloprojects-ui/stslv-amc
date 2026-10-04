import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { parseIdParam } from "../../shared/validation";
import { createExpenseSchema, listExpensesSchema, updateExpenseSchema, voidExpenseSchema } from "./expenses.schemas";
import {
  createExpense,
  getExpense,
  listExpenseCategories,
  listExpenses,
  updateExpense,
  voidExpense,
} from "./expenses.service";

export const expensesRouter = Router();

expensesRouter.use(authenticate);

expensesRouter.get("/", authorize("EXPENSES", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listExpenses(listExpensesSchema.parse(req.query)) });
});

// Declared before "/:id".
expensesRouter.get("/categories", authorize("EXPENSES", "VIEW"), async (_req, res) => {
  res.json({ success: true, data: await listExpenseCategories() });
});

expensesRouter.get("/:id", authorize("EXPENSES", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getExpense(parseIdParam(req.params.id)) });
});

expensesRouter.post("/", authorize("EXPENSES", "CREATE"), async (req, res) => {
  const expense = await createExpense(requireAuth(req), createExpenseSchema.parse(req.body));

  res.status(201).json({ success: true, data: expense });
});

expensesRouter.patch("/:id", authorize("EXPENSES", "EDIT"), async (req, res) => {
  const expense = await updateExpense(requireAuth(req), parseIdParam(req.params.id), updateExpenseSchema.parse(req.body));

  res.json({ success: true, data: expense });
});

// Expenses are never hard-deleted, so the DELETE permission governs voiding.
expensesRouter.post("/:id/void", authorize("EXPENSES", "DELETE"), async (req, res) => {
  const expense = await voidExpense(requireAuth(req), parseIdParam(req.params.id), voidExpenseSchema.parse(req.body));

  res.json({ success: true, data: expense });
});
