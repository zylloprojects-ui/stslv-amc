import type { RequestHandler } from "express";
import { forbidden } from "../../shared/errors";
import { hiddenFor, responseVisibility, type ResponseVisibility } from "../../shared/visibility-response";
import { shows, type AuthContext } from "../auth/access";
import type { RenewalQueueColumn } from "./renewal-queue.schemas";
import type { RenewalQueueItem } from "./renewal-queue.service";

// Role visibility on AMC Renewals (migration 0123). AMC Reference, Expiry and the renewal status define a row and
// always stay. Renew / Approve / Cancel load the contract itself (GET /amc/contracts/:id), never this list, so
// blanking the list can never feed a save. The Renewal History panel can be hidden as a whole.

export const ROLE_HIDEABLE_RENEWAL_COLUMNS = ["client", "system", "frequency", "service", "contractStatus", "amount", "remarks"] as const satisfies readonly RenewalQueueColumn[];
type Hideable = (typeof ROLE_HIDEABLE_RENEWAL_COLUMNS)[number];

const spec: ResponseVisibility<Hideable, RenewalQueueItem> = {
  page: "amcRenewal",
  columns: ROLE_HIDEABLE_RENEWAL_COLUMNS,
  isItem: (value): value is RenewalQueueItem => typeof value === "object" && value !== null && "renewalState" in value && "daysLeft" in value,
  blank: (item, hidden) => ({
    ...item,
    client: hidden.has("client") ? { id: item.client.id, name: "" } : item.client,
    system: hidden.has("system") ? { description: "", typeName: null } : item.system,
    frequency: hidden.has("frequency") ? { code: "", label: "" } : item.frequency,
    services: hidden.has("service") ? { completed: 0, scheduled: 0 } : item.services,
    contractStatus: hidden.has("contractStatus") ? ("" as RenewalQueueItem["contractStatus"]) : item.contractStatus,
    contractValue: hidden.has("amount") ? "" : item.contractValue,
    remarks: hidden.has("remarks") ? null : item.remarks,
  }),
};

/** Route middleware for the renewal queue (the AMC router is shared, so it is attached per route). */
export const applyRenewalQueueVisibility = responseVisibility(spec);

export const renewalHiddenColumns = (auth: Pick<AuthContext, "hidden">) => hiddenFor(auth, spec.page, spec.columns);

/** Refuses the Renewal History list and its download when the panel is hidden from the user's role. */
export const renewalHistoryVisible: RequestHandler = (req, _res, next) => {
  if (req.auth && !shows(req.auth, "amcRenewal.panel.history")) throw forbidden("This is not available to your role.");
  next();
};
