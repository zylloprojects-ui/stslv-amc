import { pool } from "../../config/database";
import { diffFields, logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, isUniqueViolation, notFound } from "../../shared/errors";
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
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS = "id, name, contact_person, email, phone, address, notes, is_active, created_at, updated_at";
const EDITABLE_FIELDS = ["name", "contactPerson", "email", "phone", "address", "notes"] as const;

function toClient(row: ClientRow): Client {
  return {
    id: row.id,
    name: row.name,
    contactPerson: row.contact_person,
    email: row.email,
    phone: row.phone,
    address: row.address,
    notes: row.notes,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const duplicateName = (name: string) =>
  conflict(`A client named "${name}" already exists.`, [
    { field: "name", message: "A client with this name already exists." },
  ]);

export async function listClients(query: ListClientsQuery) {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.status !== "all") {
    params.push(query.status === "active");
    conditions.push(`is_active = $${params.length}`);
  }

  if (query.search) {
    params.push(`%${escapeLike(query.search)}%`);
    const p = `$${params.length}`;
    conditions.push(`(name ILIKE ${p} OR contact_person ILIKE ${p} OR email ILIKE ${p} OR phone ILIKE ${p})`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM clients ${where}`, params);

  const rows = await pool.query<ClientRow>(
    `SELECT ${COLUMNS} FROM clients ${where}
     ORDER BY lower(name), id
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
  const result = await db.query<ClientRow>(`SELECT ${COLUMNS} FROM clients WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [
    id,
  ]);
  const row = result.rows[0];

  if (!row) {
    throw notFound("Client not found.");
  }

  return toClient(row);
}

export function getClient(id: string): Promise<Client> {
  return findClient(pool, id);
}

export async function createClient(auth: AuthContext, input: CreateClientInput): Promise<Client> {
  try {
    return await withTransaction(async (client) => {
      const result = await client.query<ClientRow>(
        `INSERT INTO clients (name, contact_person, email, phone, address, notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING ${COLUMNS}`,
        [
          input.name,
          input.contactPerson ?? null,
          input.email ?? null,
          input.phone ?? null,
          input.address ?? null,
          input.notes ?? null,
          auth.user.id,
        ]
      );
      const created = toClient(result.rows[0] as ClientRow);

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
  try {
    return await withTransaction(async (client) => {
      const before = await findClient(client, id, true);
      const after: Client = { ...before };

      for (const field of EDITABLE_FIELDS) {
        const value = input[field];
        if (value !== undefined) {
          (after[field] as string | null) = value;
        }
      }

      const changes = diffFields(
        before as unknown as Record<string, unknown>,
        after as unknown as Record<string, unknown>,
        EDITABLE_FIELDS
      );

      if (Object.keys(changes).length === 0) {
        return before;
      }

      const result = await client.query<ClientRow>(
        `UPDATE clients
         SET name = $1, contact_person = $2, email = $3, phone = $4, address = $5, notes = $6, updated_by = $7
         WHERE id = $8
         RETURNING ${COLUMNS}`,
        [after.name, after.contactPerson, after.email, after.phone, after.address, after.notes, auth.user.id, id]
      );
      const updated = toClient(result.rows[0] as ClientRow);

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

    const result = await client.query<ClientRow>(
      `UPDATE clients SET is_active = $1, updated_by = $2 WHERE id = $3 RETURNING ${COLUMNS}`,
      [isActive, auth.user.id, id]
    );
    const updated = toClient(result.rows[0] as ClientRow);

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
