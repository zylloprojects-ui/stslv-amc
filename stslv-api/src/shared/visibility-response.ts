import type { RequestHandler } from "express";
import { hiddenColumnsOf, type AuthContext } from "../modules/auth/access";

// Role visibility (migration 0123) for a whole router: every JSON answer is passed through the page's own blanking
// rule before it leaves the server, so no route of the page can send a hidden column by mistake. The page decides
// what an item is and how to blank it; lists ({ items, ... }) and single items are handled alike.

export interface ResponseVisibility<C extends string, T> {
  /** The catalogue prefix ("serviceSales" → "serviceSales.column.<id>"). */
  page: string;
  columns: readonly C[];
  /** Whether a value is one of this page's items. */
  isItem: (value: unknown) => value is T;
  /** The item without the hidden columns' data. */
  blank: (item: T, hidden: ReadonlySet<C>) => T;
  /** Extra list fields (totals, KPI figures) to drop or null when columns are hidden. */
  listExtras?: (list: Record<string, unknown>, hidden: ReadonlySet<C>) => Record<string, unknown>;
}

export const hiddenFor = <C extends string>(auth: Pick<AuthContext, "hidden">, page: string, columns: readonly C[]) => hiddenColumnsOf(auth, page, columns);

export function presentWithVisibility<C extends string, T>(spec: ResponseVisibility<C, T>, data: unknown, hidden: ReadonlySet<C>): unknown {
  if (Array.isArray(data)) return data.map((entry) => (spec.isItem(entry) ? spec.blank(entry, hidden) : entry));
  if (spec.isItem(data)) return spec.blank(data, hidden);
  if (typeof data === "object" && data !== null && "items" in data && Array.isArray((data as { items: unknown[] }).items)) {
    const list = data as Record<string, unknown> & { items: unknown[] };
    const withItems = { ...list, items: list.items.map((entry) => (spec.isItem(entry) ? spec.blank(entry, hidden) : entry)), roleHiddenColumns: [...hidden] };
    return spec.listExtras ? spec.listExtras(withItems, hidden) : withItems;
  }
  return data;
}

/** Router middleware applying the page's visibility to every JSON answer. */
export function responseVisibility<C extends string, T>(spec: ResponseVisibility<C, T>): RequestHandler {
  return (req, res, next) => {
    const json = res.json.bind(res);

    res.json = (body: unknown) => {
      const hidden = req.auth ? hiddenFor(req.auth, spec.page, spec.columns) : new Set<C>();
      if (hidden.size > 0 && typeof body === "object" && body !== null && "data" in body) {
        return json({ ...(body as Record<string, unknown>), data: presentWithVisibility(spec, (body as { data: unknown }).data, hidden) });
      }
      return json(body);
    };
    next();
  };
}

/** Removes the named keys from an object (a figure that must not be sent). */
export function without(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}
