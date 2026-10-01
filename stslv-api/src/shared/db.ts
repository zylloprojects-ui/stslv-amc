import type { Pool, PoolClient } from "pg";
import { pool } from "../config/database";

/** Either the shared pool or a client inside a transaction. */
export type Queryable = Pool | PoolClient;

/** Runs fn inside one transaction: commits when it resolves, rolls back when it throws. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
