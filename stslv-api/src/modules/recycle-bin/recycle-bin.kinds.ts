import type { Module } from "../../shared/permissions";

// The record types the Recycle Bin holds (approved 2026-11-04). AMC contracts came
// first (migration 0101); clients, system types and sales engineers follow the same
// pattern (migration 0106): the row stays in <table>_all with deleted_at set, and the
// view with the old name no longer shows it.

export const RECYCLE_TYPES = ["AMC_CONTRACT", "CLIENT", "SYSTEM_TYPE", "SALES_ENGINEER"] as const;
export type RecycleType = (typeof RECYCLE_TYPES)[number];

/** The master record types. AMC contracts are never permanently deleted (D4), so they are handled apart. */
export type MasterRecycleType = Exclude<RecycleType, "AMC_CONTRACT">;
export const MASTER_RECYCLE_TYPES: readonly MasterRecycleType[] = ["CLIENT", "SYSTEM_TYPE", "SALES_ENGINEER"];

export interface MasterKind {
  type: MasterRecycleType;
  /** The base table, which holds every row including those in the Recycle Bin. */
  table: string;
  /** Activity log entity type and action prefix. */
  entityType: string;
  actionPrefix: string;
  module: Module;
  /** "Client", for messages. */
  label: string;
  /** amc_contracts_all column that points at this record. */
  contractColumn: string;
  /** SQL for the code users see, for the row aliased as given. */
  codeSql: (alias: string) => string;
  /** Keys under which other activity log entries may store this record's id. */
  idKeys: string[];
}

export const MASTER_KINDS: Record<MasterRecycleType, MasterKind> = {
  CLIENT: {
    type: "CLIENT",
    table: "clients_all",
    entityType: "clients",
    actionPrefix: "client",
    module: "CLIENTS",
    label: "Client",
    contractColumn: "client_id",
    // The client code is derived from the id (clients.service.ts clientCode).
    codeSql: (alias) => `('CL-' || lpad(${alias}.id::text, greatest(5, length(${alias}.id::text)), '0'))`,
    idKeys: ["clientId", "client_id"],
  },
  SYSTEM_TYPE: {
    type: "SYSTEM_TYPE",
    table: "system_types_all",
    entityType: "system_types",
    actionPrefix: "system_type",
    module: "SYSTEM_TYPES",
    label: "System type",
    contractColumn: "system_type_id",
    codeSql: (alias) => `${alias}.code`,
    idKeys: ["systemTypeId", "system_type_id"],
  },
  SALES_ENGINEER: {
    type: "SALES_ENGINEER",
    table: "sales_engineers_all",
    entityType: "sales_engineers",
    actionPrefix: "sales_engineer",
    module: "SALES_ENGINEERS",
    label: "Sales engineer",
    contractColumn: "sales_engineer_id",
    codeSql: (alias) => `${alias}.code`,
    idKeys: ["salesEngineerId", "sales_engineer_id", "engineerId"],
  },
};

export const TYPE_LABELS: Record<RecycleType, string> = {
  AMC_CONTRACT: "AMC contract",
  CLIENT: "Client",
  SYSTEM_TYPE: "System type",
  SALES_ENGINEER: "Sales engineer",
};
