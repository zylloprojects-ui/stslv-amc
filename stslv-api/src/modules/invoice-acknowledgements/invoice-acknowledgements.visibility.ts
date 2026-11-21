import type { RequestHandler } from "express";
import { requireAuth } from "../../middleware/authenticate";
import { hiddenColumnsOf } from "../auth/access";
import type { AcknowledgementColumn } from "./invoice-acknowledgements.schemas";
import type { AcknowledgementItem, LinkedService } from "./invoice-acknowledgements.service";

// Role visibility on Invoice Acknowledgements (migration 0123, shared/visibility-catalog.ts). A column hidden from the
// user's role is blanked in every response of this router and left out of the export. Invoice No., the
// acknowledgement status, the services count and the document itself always stay: the actions (confirm, view
// document, linked services) work from them, so blanking them could break a workflow.

export const ROLE_HIDEABLE_ACK_COLUMNS = ["client", "contract", "invoiceDate", "invoiceValue", "serviceValue", "acknowledgedAt", "acknowledgedBy", "uploadedBy"] as const satisfies readonly AcknowledgementColumn[];
type Hideable = (typeof ROLE_HIDEABLE_ACK_COLUMNS)[number];

export const ackHiddenColumns = (auth: Parameters<typeof hiddenColumnsOf>[0]) => hiddenColumnsOf(auth, "invoiceAcks", ROLE_HIDEABLE_ACK_COLUMNS);

function presentItem(item: AcknowledgementItem, hidden: ReadonlySet<Hideable>): AcknowledgementItem {
  const off = (column: Hideable) => hidden.has(column);

  return {
    ...item,
    client: off("client") ? { id: item.client.id, name: "" } : item.client,
    contracts: off("contract") ? [] : item.contracts,
    invoiceDate: off("invoiceDate") ? null : item.invoiceDate,
    invoiceValue: off("invoiceValue") ? null : item.invoiceValue,
    serviceValue: off("serviceValue") ? null : item.serviceValue,
    acknowledgedAt: off("acknowledgedAt") ? null : item.acknowledgedAt,
    acknowledgedBy: off("acknowledgedBy") ? null : item.acknowledgedBy,
    document: item.document && off("uploadedBy") ? { ...item.document, uploadedBy: { id: "", fullName: "" } } : item.document,
  };
}

const isItem = (value: unknown): value is AcknowledgementItem => typeof value === "object" && value !== null && "invoiceId" in value && "invoiceNo" in value;
const isService = (value: unknown): value is LinkedService => typeof value === "object" && value !== null && "visitId" in value && "serviceValue" in value;

/** Applies role visibility to whatever this router answers: a list, one invoice, or linked services. */
function present(data: unknown, hidden: ReadonlySet<Hideable>): unknown {
  if (Array.isArray(data)) return data.map((entry) => (isService(entry) && hidden.has("serviceValue") ? { ...entry, serviceValue: null } : isItem(entry) ? presentItem(entry, hidden) : entry));
  if (isItem(data)) return presentItem(data, hidden);
  if (typeof data === "object" && data !== null && "items" in data && Array.isArray((data as { items: unknown[] }).items)) {
    const list = data as { items: unknown[]; kpis?: Record<string, unknown> };
    const kpis = list.kpis
      ? {
          ...list.kpis,
          ...(hidden.has("invoiceValue") ? { invoiceValueTotal: null } : {}),
          ...(hidden.has("serviceValue") ? { serviceValueTotal: null } : {}),
        }
      : list.kpis;
    return { ...list, items: list.items.map((entry) => present(entry, hidden)), kpis, roleHiddenColumns: [...hidden] };
  }
  return data;
}

/** Router middleware: every JSON answer of Invoice Acknowledgements goes through role visibility. */
export const applyAcknowledgementVisibility: RequestHandler = (req, res, next) => {
  const json = res.json.bind(res);

  res.json = (body: unknown) => {
    const hidden = req.auth ? ackHiddenColumns(requireAuth(req)) : new Set<Hideable>();
    if (hidden.size > 0 && typeof body === "object" && body !== null && "data" in body) {
      return json({ ...(body as Record<string, unknown>), data: present((body as { data: unknown }).data, hidden) });
    }
    return json(body);
  };
  next();
};
