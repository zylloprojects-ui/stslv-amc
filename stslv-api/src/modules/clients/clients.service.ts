import { pool } from "../../config/database";
import { featureUnavailable } from "../../middleware/require-schema";
import { diffFields, logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { listEntityHistory } from "../../shared/entity-history";
import { conflict, isUniqueViolation, notFound } from "../../shared/errors";
import { schemaHas } from "../../shared/schema-features";
import { escapeLike } from "../../shared/validation";
import type { AuthContext } from "../auth/access";
import type { CreateClientInput, ListClientsQuery, UpdateClientInput } from "./clients.schemas";

interface ClientRow {
  id: string;
  name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  client_type: "COMPANY" | "INDIVIDUAL" | null;
  vat_number: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Client {
  id: string;
  name: string;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  /** Migration 0074; null when not set or on a database without it. */
  clientType: "COMPANY" | "INDIVIDUAL" | null;
  vatNumber: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const BASE_COLUMNS = "id, name, contact_person, email, phone, address, notes, is_active, created_at, updated_at";
const BASE_FIELDS = ["name", "contactPerson", "email", "phone", "address", "notes"] as const;
const DETAIL_FIELDS = ["clientType", "vatNumber"] as const;

/** Whether this database has the client type and VAT number columns (migration 0074). */
export function hasClientDetails(): Promise<boolean> {
  return schemaHas(["clients.client_type", "clients.vat_number"]);
}

async function columns(): Promise<string> {
  return (await hasClientDetails())
    ? `${BASE_COLUMNS}, client_type, vat_number`
    : `${BASE_COLUMNS}, NULL::text AS client_type, NULL::text AS vat_number`;
}

function toClient(row: ClientRow): Client {
  return {
    id: row.id,
    name: row.name,
    contactPerson: row.contact_person,
    email: row.email,
    phone: row.phone,
    address: row.address,
    notes: row.notes,
    clientType: row.client_type,
    vatNumber: row.vat_number,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const duplicateName = (name: string) =>
  conflict(`A client named "${name}" already exists.`, [
    { field: "name", message: "A client with this name already exists." },
  ]);

/** A value for client type or VAT number can only be stored once the database has the columns. */
async function assertDetailsStorable(input: { clientType?: unknown; vatNumber?: unknown }, details: boolean) {
  const given = (input.clientType !== undefined && input.clientType !== null) || (input.vatNumber !== undefined && input.vatNumber !== null);

  if (given && !details) {
    throw featureUnavailable();
  }
}

const SORTS: Record<ListClientsQuery["sort"], string> = {
  name: "lower(name)",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

export async function listClients(query: ListClientsQuery) {
  const details = await hasClientDetails();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.status !== "all") {
    params.push(query.status === "active");
    conditions.push(`is_active = $${params.length}`);
  }

  if (query.clientType && details) {
    params.push(query.clientType);
    conditions.push(`client_type = $${params.length}`);
  }

  if (query.search) {
    params.push(`%${escapeLike(query.search)}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(name ILIKE ${p} OR contact_person ILIKE ${p} OR email ILIKE ${p} OR phone ILIKE ${p}${details ? ` OR vat_number ILIKE ${p}` : ""})`
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM clients ${where}`, params);
  const direction = query.direction === "desc" ? "DESC" : "ASC";

  const rows = await pool.query<ClientRow>(
    `SELECT ${await columns()} FROM clients ${where}
     ORDER BY ${SORTS[query.sort]} ${direction}, id ${direction}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );

  return {
    items: rows.rows.map(toClient),
    total: total.rows[0]?.count ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

async function findClient(db: Queryable, id: string, lock = false): Promise<Client> {
  const result = await db.query<ClientRow>(`SELECT ${await columns()} FROM clients WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  const row = result.rows[0];

  if (!row) {
    throw notFound("Client not found.");
  }

  return toClient(row);
}

export function getClient(id: string): Promise<Client> {
  return findClient(pool, id);
}

/** What the Clients pages can offer on this database. */
export async function clientFeatures() {
  return { clientDetails: await hasClientDetails() };
}

/** The activity recorded against one client, newest first. */
export async function listClientHistory(id: string, page: number, pageSize: number) {
  await findClient(pool, id);

  return listEntityHistory("clients", id, page, pageSize);
}

export async function createClient(auth: AuthContext, input: CreateClientInput): Promise<Client> {
  const details = await hasClientDetails();

  await assertDetailsStorable(input, details);

  try {
    return await withTransaction(async (client) => {
      const values = [
        input.name,
        input.contactPerson ?? null,
        input.email ?? null,
        input.phone ?? null,
        input.address ?? null,
        input.notes ?? null,
        auth.user.id,
      ];
      const inserted = details
        ? await client.query<{ id: string }>(
            `INSERT INTO clients (name, contact_person, email, phone, address, notes, created_by, updated_by, client_type, vat_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9) RETURNING id`,
            [...values, input.clientType ?? null, input.vatNumber ?? null]
          )
        : await client.query<{ id: string }>(
            `INSERT INTO clients (name, contact_person, email, phone, address, notes, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
            values
          );
      const created = await findClient(client, (inserted.rows[0] as { id: string }).id);

      await logActivity(client, {
        userId: auth.user.id,
        action: "client.created",
        module: "CLIENTS",
        entityType: "clients",
        entityId: created.id,
        description: `Client "${created.name}" created.`,
      });

      return created;
    });
  } catch (error) {
    if (isUniqueViolation(error, "clients_name_uq")) {
      throw duplicateName(input.name);
    }
    throw error;
  }
}

export async function updateClient(auth: AuthContext, id: string, input: UpdateClientInput): Promise<Client> {
  const details = await hasClientDetails();

  await assertDetailsStorable(input, details);

  const fields = details ? [...BASE_FIELDS, ...DETAIL_FIELDS] : [...BASE_FIELDS];

  try {
    return await withTransaction(async (client) => {
      const before = await findClient(client, id, true);
      const after: Client = { ...before };

      for (const field of fields) {
        const value = input[field];
        if (value !== undefined) {
          (after[field] as string | null) = value;
        }
      }

      const changes = diffFields(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, fields);

      if (Object.keys(changes).length === 0) {
        return before;
      }

      const params: unknown[] = [after.name, after.contactPerson, after.email, after.phone, after.address, after.notes, auth.user.id, id];
      await client.query(
        details
          ? `UPDATE clients
             SET name = $1, contact_person = $2, email = $3, phone = $4, address = $5, notes = $6, updated_by = $7,
                 client_type = $9, vat_number = $10
             WHERE id = $8`
          : `UPDATE clients
             SET name = $1, contact_person = $2, email = $3, phone = $4, address = $5, notes = $6, updated_by = $7
             WHERE id = $8`,
        details ? [...params, after.clientType, after.vatNumber] : params
      );
      const updated = await findClient(client, id);

      await logActivity(client, {
        userId: auth.user.id,
        action: "client.updated",
        module: "CLIENTS",
        entityType: "clients",
        entityId: id,
        description: `Client "${updated.name}" updated.`,
        metadata: { changes },
      });

      return updated;
    });
  } catch (error) {
    if (isUniqueViolation(error, "clients_name_uq")) {
      throw duplicateName(input.name ?? "");
    }
    throw error;
  }
}

/** Deactivation replaces deletion: the record stays for anything that references it. */
export function setClientActive(auth: AuthContext, id: string, isActive: boolean): Promise<Client> {
  return withTransaction(async (client) => {
    const before = await findClient(client, id, true);

    if (before.isActive === isActive) {
      return before;
    }

    await client.query("UPDATE clients SET is_active = $1, updated_by = $2 WHERE id = $3", [isActive, auth.user.id, id]);
    const updated = await findClient(client, id);

    await logActivity(client, {
      userId: auth.user.id,
      action: isActive ? "client.reactivated" : "client.deactivated",
      module: "CLIENTS",
      entityType: "clients",
      entityId: id,
      description: `Client "${updated.name}" ${isActive ? "reactivated" : "deactivated"}.`,
    });

    return updated;
  });
}
