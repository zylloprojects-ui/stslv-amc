import { hiddenFieldsFor, hiddenReportKeys, responseFields, type ResponseFields } from "../../shared/visibility-fields";
import type { AuthContext } from "../auth/access";

// Role visibility on AMC Contracts (migration 0123, step B "Lock it"). Only optional fields that drive no amount are
// hideable: Cost per Visit (the amount a new visit is given when no Billing Basis is set: kept exactly as stored, never
// recalculated), Customer PO Value (a record only), Description and Notes. Everything required to add a contract,
// the Billing Basis and its custom value, the status and the visit counts always stay.
//
// The contract form shows a hidden field locked and does not send it; the service keeps the stored value whatever is
// sent (updateContract). A renewal by such a user keeps what the renewal form would have started from: the renewed
// contract's Cost per Visit and Description (Customer PO Value and Notes start empty on a renewal).

export const CONTRACT_FIELD_VISIBILITY = {
  page: "amcContracts",
  fields: {
    costPerVisit: ["defaultVisitAmount"],
    customerPoValue: ["customerPoValue"],
    description: ["description"],
    notes: ["notes"],
  },
} as const;

type Column = keyof (typeof CONTRACT_FIELD_VISIBILITY)["fields"];

const spec: ResponseFields<Column> = {
  ...CONTRACT_FIELD_VISIBILITY,
  isItem: (value) => typeof value === "object" && value !== null && "amcReference" in value && "contractVersion" in value && "schedule" in value,
  // A contract's creation entry quotes its Customer PO Value.
  historyDescription: (text, hidden) => (hidden.has("customerPoValue") ? text.replace(/ Customer PO Value \(ex VAT\) [\d.,]+\./g, "") : text),
};

/** Middleware for the /contracts routes of the AMC router: every JSON answer leaves out the hidden fields. */
export const applyContractVisibility = responseFields(spec);

/** The contract fields hidden from the user: a save never changes them (the stored values are kept). */
export const contractHiddenFields = (auth: Pick<AuthContext, "hidden">) => hiddenFieldsFor(auth, CONTRACT_FIELD_VISIBILITY);

/** The report columns of the contract downloads left out for the user (the register's and a client's contracts). */
export const contractHiddenReportKeys = (auth: Pick<AuthContext, "hidden">) =>
  hiddenReportKeys(auth, CONTRACT_FIELD_VISIBILITY, { costPerVisit: ["visitValue"], customerPoValue: ["customerPoValue"], notes: ["notes"] });
