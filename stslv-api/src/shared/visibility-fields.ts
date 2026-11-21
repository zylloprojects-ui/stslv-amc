import type { RequestHandler } from "express";
import { shows, type AuthContext } from "../modules/auth/access";

// Role visibility (migration 0123), step B: pages whose edit form is filled from the record and saves every field
// back (Invoice Tracking, AMC Contracts, Clients and the master lists). The owner's rule ("Lock it", 2026-11-21):
//   * a field hidden from the user's role is blanked (null) in every answer of the page and left out of its downloads;
//   * the edit form shows it locked and does not send it;
//   * the API keeps the stored value of any field hidden from the user who saves, whatever is sent (keepHiddenFields,
//     called by each page's service before it reads the input). Nothing is erased or changed because it was hidden.

type Auth = Pick<AuthContext, "hidden"> | undefined;

export interface FieldVisibility<C extends string> {
  /** The catalogue prefix ("clients" → "clients.column.<id>"). */
  page: string;
  /** Each hideable column and the field names it covers: as sent by the form, as answered, and as logged in history. */
  fields: Record<C, readonly string[]>;
}

/** The page's columns hidden from the user. */
export function hiddenColumnsFor<C extends string>(auth: Auth, spec: FieldVisibility<C>): C[] {
  if (!auth) return [];
  return (Object.keys(spec.fields) as C[]).filter((column) => !shows(auth, `${spec.page}.column.${column}`));
}

/** The field names hidden from the user on the page. */
export function hiddenFieldsFor<C extends string>(auth: Auth, spec: FieldVisibility<C>): Set<string> {
  return new Set(hiddenColumnsFor(auth, spec).flatMap((column) => spec.fields[column]));
}

/**
 * The input without the fields hidden from the user who saves: a left-out field is never changed, so the stored value
 * is kept whatever the request sent (a different value, an empty one, or null).
 */
export function keepHiddenFields<T extends object>(input: T, hidden: ReadonlySet<string>): T {
  if (hidden.size === 0) return input;
  return Object.fromEntries(Object.entries(input).filter(([field]) => !hidden.has(field))) as T;
}

/** A copy of the record with the hidden fields it has set to null. */
export function blankFields<T extends object>(item: T, hidden: ReadonlySet<string>): T {
  const copy = { ...item } as Record<string, unknown>;
  for (const field of hidden) if (field in copy) copy[field] = null;
  return copy as T;
}

interface HistoryLike {
  action: string;
  description: string | null;
  changes: Record<string, unknown> | null;
}

const isHistoryEntry = (value: unknown): value is HistoryLike => typeof value === "object" && value !== null && "action" in value && "changes" in value;

/** A history entry without the recorded changes of hidden fields. */
function historyWithout(entry: HistoryLike, hidden: ReadonlySet<string>, description?: (text: string, hidden: ReadonlySet<string>) => string): HistoryLike {
  const changes = entry.changes ? Object.fromEntries(Object.entries(entry.changes).filter(([field]) => !hidden.has(field))) : entry.changes;
  return { ...entry, changes, description: entry.description && description ? description(entry.description, hidden) : entry.description };
}

export interface ResponseFields<C extends string> extends FieldVisibility<C> {
  /** Whether a value is one of this page's records. */
  isItem: (value: unknown) => boolean;
  /** The record without the hidden fields' data. Default: blankFields. */
  blank?: (item: Record<string, unknown>, hidden: ReadonlySet<string>) => Record<string, unknown>;
  /** Other figures of an answer (totals, summaries) that come from a hidden field. */
  extras?: (data: Record<string, unknown>, hidden: ReadonlySet<string>) => Record<string, unknown>;
  /** A history entry's text without a hidden value it quotes. */
  historyDescription?: (text: string, hidden: ReadonlySet<string>) => string;
}

/** Applies the page's field visibility to one answer: a record, a list of them, a page ({ items }), history, or an object holding a record. */
export function presentFields<C extends string>(spec: ResponseFields<C>, data: unknown, hidden: ReadonlySet<string>, columns: readonly C[]): unknown {
  const blank = (value: unknown): unknown => {
    if (spec.isItem(value)) return (spec.blank ?? blankFields)(value as Record<string, unknown>, hidden);
    if (isHistoryEntry(value)) return historyWithout(value, hidden, spec.historyDescription);
    return value;
  };

  if (Array.isArray(data)) return data.map(blank);
  if (typeof data !== "object" || data === null) return data;
  if (spec.isItem(data)) return blank(data);

  let out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  if (Array.isArray(out.items)) out = { ...out, items: (out.items as unknown[]).map(blank), roleHiddenColumns: [...columns] };
  // An answer that holds a record next to other details ({ contract, scheduleChange, ... }).
  for (const [key, value] of Object.entries(out)) if (key !== "items" && spec.isItem(value)) out[key] = blank(value);
  return spec.extras ? spec.extras(out, hidden) : out;
}

/** Router middleware: every JSON answer passes through the page's field visibility before it leaves the server. */
export function responseFields<C extends string>(spec: ResponseFields<C>): RequestHandler {
  return (req, res, next) => {
    const json = res.json.bind(res);

    res.json = (body: unknown) => {
      const columns = hiddenColumnsFor(req.auth, spec);
      if (columns.length > 0 && typeof body === "object" && body !== null && "data" in body) {
        const hidden = new Set(columns.flatMap((column) => spec.fields[column]));
        return json({ ...(body as Record<string, unknown>), data: presentFields(spec, (body as { data: unknown }).data, hidden, columns) });
      }
      return json(body);
    };
    next();
  };
}

/** The report columns of a download left out for the user: each hidden column's report keys. */
export function hiddenReportKeys<C extends string>(auth: Auth, spec: FieldVisibility<C>, reportKeys: Partial<Record<C, readonly string[]>>): Set<string> {
  return new Set(hiddenColumnsFor(auth, spec).flatMap((column) => reportKeys[column] ?? []));
}
