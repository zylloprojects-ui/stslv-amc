import { hiddenFieldsFor, hiddenReportKeys, responseFields, type ResponseFields } from "../../shared/visibility-fields";
import type { AuthContext } from "../auth/access";

// Role visibility on Clients (migration 0123, step B "Lock it"). The client list also feeds the client pickers of the
// AMC pages, so only contact details are hideable: the id, code and name always stay, and the client type is required
// when adding a client. The client form shows a hidden field locked and does not send it; the service keeps the stored
// value whatever is sent (createClient / updateClient).

export const CLIENT_FIELD_VISIBILITY = {
  page: "clients",
  fields: {
    contactPerson: ["contactPerson"],
    email: ["email"],
    phone: ["phone"],
    address: ["address"],
    vatNumber: ["vatNumber"],
    notes: ["notes"],
  },
} as const;

type Column = keyof (typeof CLIENT_FIELD_VISIBILITY)["fields"];

const spec: ResponseFields<Column> = {
  ...CLIENT_FIELD_VISIBILITY,
  isItem: (value) => typeof value === "object" && value !== null && "code" in value && "name" in value && "contactPerson" in value && "vatNumber" in value,
};

/** Router middleware: every JSON answer of Clients leaves out the fields hidden from the user's role. */
export const applyClientVisibility = responseFields(spec);

/** The client fields hidden from the user: a save never changes them (the stored values are kept). */
export const clientHiddenFields = (auth: Pick<AuthContext, "hidden">) => hiddenFieldsFor(auth, CLIENT_FIELD_VISIBILITY);

/** The report columns of the client list download left out for the user. */
export const clientHiddenReportKeys = (auth: Pick<AuthContext, "hidden">) =>
  hiddenReportKeys(auth, CLIENT_FIELD_VISIBILITY, {
    contactPerson: ["contactPerson"],
    email: ["email"],
    phone: ["phone"],
    address: ["address"],
    vatNumber: ["vatNumber"],
    notes: ["remarks"],
  });
