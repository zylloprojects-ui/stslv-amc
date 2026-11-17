import { schemaHas } from "../../shared/schema-features";

// The Service Engineer of one maintenance visit (client UAT 2026-11-16, CR-008/CR-010/CR-012/CR-016): the person who
// performed the service, typed on AMC Execution › Service Status beside the Service Report No.
//
// It is stored in amc_visits.sales_engineer_name (migration 0110). That column was added on 2026-11-09 under the label
// "Sales Engineer Name"; the client's UAT workbook (Engineer Field Matrix) identifies this same input as the Service
// Engineer, so only the label changes and the column keeps its name. Nothing is copied from the contract's Sales
// Engineer (amc_contracts.sales_engineer_id, the person who brought the AMC), and nothing is backfilled: a visit
// without an entry has no Service Engineer.

/** Migration 0110 stores the Service Engineer of a visit. */
export const hasServiceEngineer = () => schemaHas(["amc_visits.sales_engineer_name"]);

/** The visit's Service Engineer, or NULL on a database without 0110. Expects the amc_visits alias "v". */
export const serviceEngineerSql = (available: boolean) => (available ? "v.sales_engineer_name" : "NULL::text");
