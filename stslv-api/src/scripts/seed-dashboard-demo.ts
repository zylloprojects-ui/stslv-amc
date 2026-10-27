import { databaseSchema, pool } from "../config/database";
import { addDays, addMonths } from "../modules/amc/amc.schedule";
import { createContractSchema, updateExecutionSchema } from "../modules/amc/amc.schemas";
import { createContract } from "../modules/amc/contracts.service";
import { updateExecution } from "../modules/amc/visits.service";
import type { AuthContext } from "../modules/auth/access";
import { loadUserPermissions, loadUserRoles } from "../modules/auth/access";
import { createInvoiceSchema } from "../modules/invoices/invoices.schemas";
import { createInvoice } from "../modules/invoices/invoices.service";
import { ADMIN_ROLE_CODE } from "../shared/permissions";

// Fictional demonstration records for the AMC Operations Dashboard.
//
//   npx tsx src/scripts/seed-dashboard-demo.ts                 (prints what it would do, writes nothing)
//   npx tsx src/scripts/seed-dashboard-demo.ts --insert-demo   (writes the records)
//
// Every record is clearly fictional: client names start with "DEMO –" and the
// invoice numbers with "DEMO-". Running it again does nothing once the demo
// clients exist. It goes through the normal services, so schedules are
// generated and every change is in the activity log, created by the first
// active Admin user of the target database.
//
// Do NOT run it with --insert-demo against stslv_amc_dev (or any shared
// database) without explicit approval. Removing the records afterwards needs a
// reviewed script: invoices and visits are protected by foreign keys on purpose.

const MARKER = "DEMO –";
const CLIENTS = [`${MARKER} Fictional Harbour Hotel`, `${MARKER} Fictional City Tower`, `${MARKER} Fictional Palm Clinic`];

async function actor(): Promise<AuthContext> {
  const result = await pool.query<{ id: string; email: string; full_name: string }>(
    `SELECT u.id, u.email, u.full_name FROM users u
     JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
     WHERE r.code = $1 AND u.is_active ORDER BY u.id LIMIT 1`,
    [ADMIN_ROLE_CODE]
  );
  const user = result.rows[0];

  if (!user) throw new Error("No active Admin user in the target database: create one first (npm run admin:create).");

  return {
    user: { id: user.id, email: user.email, fullName: user.full_name },
    roles: await loadUserRoles(pool, user.id),
    permissions: await loadUserPermissions(pool, user.id),
  };
}

async function main() {
  const insert = process.argv.includes("--insert-demo");
  const target = await pool.query<{ db: string; today: string }>("SELECT current_database() AS db, current_date::text AS today");
  const { db, today } = target.rows[0] as { db: string; today: string };

  console.log(`Target: database ${db}, schema ${databaseSchema ?? "public"}, today ${today}.`);

  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo data with NODE_ENV=production.");

  const existing = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM clients WHERE name LIKE $1", [`${MARKER}%`]);
  if ((existing.rows[0]?.n ?? 0) > 0) {
    console.log("Demo clients already exist: nothing to do.");
    return;
  }

  if (!insert) {
    console.log(`Would create ${CLIENTS.length} demo clients, 5 contracts (4 active, 1 draft), complete 2 visits and record 1 demo invoice.`);
    console.log("Nothing was written. Re-run with --insert-demo to write the records.");
    return;
  }

  const auth = await actor();
  const clientIds: string[] = [];

  for (const name of CLIENTS) {
    const row = await pool.query<{ id: string }>(
      "INSERT INTO clients (name, notes, created_by, updated_by) VALUES ($1, 'Fictional record for dashboard demonstration.', $2, $2) RETURNING id",
      [name, auth.user.id]
    );
    clientIds.push((row.rows[0] as { id: string }).id);
  }
  const [harbour, tower, clinic] = clientIds as [string, string, string];

  const contract = (body: Record<string, unknown>) =>
    createContract(auth, createContractSchema.parse({ responsibleEngineer: "Demo Engineer", notes: "Fictional demonstration contract.", ...body }));

  // Ends in 30 days: in the 45-day KPI.
  const fire = await contract({
    clientId: harbour,
    systemDescription: "FIRE ALARM (DEMO)",
    validFrom: addDays(addMonths(today, -11), 1),
    validTo: addDays(today, 30),
    contractValue: "1200.000",
    finalCredit: "1100.000",
    maintenanceFrequency: "MONTHLY",
    defaultVisitAmount: "100.000",
    status: "ACTIVE",
  });
  await contract({
    clientId: tower,
    systemDescription: "CCTV (DEMO)",
    validFrom: addMonths(today, -3),
    validTo: addDays(addMonths(today, 9), -1),
    contractValue: "2400.000",
    finalCredit: "2400.000",
    maintenanceFrequency: "QUARTERLY",
    defaultVisitAmount: "600.000",
    status: "ACTIVE",
  });
  // Ends in 70 days: in the 90-day list only.
  const hvac = await contract({
    clientId: clinic,
    systemDescription: "HVAC (DEMO)",
    validFrom: addMonths(today, -1),
    validTo: addDays(today, 70),
    contractValue: "900.000",
    maintenanceFrequency: "MONTHLY",
    defaultVisitAmount: "250.000",
    status: "ACTIVE",
  });
  await contract({
    clientId: tower,
    systemDescription: "PUMPS (DEMO)",
    validFrom: addMonths(today, -2),
    validTo: addDays(addMonths(today, 22), -1),
    contractValue: "3600.000",
    maintenanceFrequency: "HALF_YEARLY",
    defaultVisitAmount: "900.000",
    status: "ACTIVE",
  });
  await contract({
    clientId: clinic,
    systemDescription: "ACCESS CONTROL (DEMO)",
    validFrom: addMonths(today, 1),
    validTo: addDays(addMonths(today, 13), -1),
    contractValue: "500.000",
    maintenanceFrequency: "QUARTERLY",
    defaultVisitAmount: "125.000",
  });

  // Two past visits of the fire alarm contract completed; one of them invoiced.
  const visits = await pool.query<{ id: string; scheduled_date: string }>(
    "SELECT id, scheduled_date::text AS scheduled_date FROM amc_visits WHERE amc_contract_id = $1 AND scheduled_date < current_date ORDER BY scheduled_date LIMIT 2",
    [fire.id]
  );
  for (const visit of visits.rows) {
    await updateExecution(auth, visit.id, updateExecutionSchema.parse({ status: "COMPLETED", completedDate: visit.scheduled_date }));
  }
  const invoiced = visits.rows[0];
  if (invoiced) {
    await createInvoice(
      auth,
      createInvoiceSchema.parse({
        invoiceNumber: "DEMO-INV-0001",
        clientId: harbour,
        invoiceDate: today,
        amountExclVat: "100.000",
        vatAmount: "5.000",
        notes: "Fictional demonstration invoice.",
        allocations: [{ amcVisitId: invoiced.id, amount: "100.000" }],
      })
    );
  }

  // One HVAC visit planned for today, so "Today" has work to show.
  const next = await pool.query<{ id: string }>(
    "SELECT id FROM amc_visits WHERE amc_contract_id = $1 AND status = 'SCHEDULED' AND scheduled_date >= current_date ORDER BY scheduled_date LIMIT 1",
    [hvac.id]
  );
  if (next.rows[0]) {
    await updateExecution(auth, next.rows[0].id, updateExecutionSchema.parse({ scheduledDate: today }));
  }

  console.log("Demo records created.");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
