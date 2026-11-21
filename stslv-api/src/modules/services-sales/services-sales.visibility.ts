import { hiddenFor, responseVisibility, without, type ResponseVisibility } from "../../shared/visibility-response";
import type { AuthContext } from "../auth/access";
import type { ServicesSalesColumn } from "./services-sales.schemas";
import type { ServicesSalesItem } from "./services-sales.service";

// Role visibility on Service Sales (migration 0123). AMC Reference, Due Date and Service Status define a row and
// always stay; Quote No. is entered on this page, so it is never withheld (a save from a blanked field would erase it).
// "serviceReport" also stops viewing and downloading the report.

export const ROLE_HIDEABLE_SALES_COLUMNS = ["client", "system", "frequency", "service", "serviceReportNo", "serviceReport", "serviceEngineer", "salesEngineer", "amcValue", "serviceValue"] as const;
type Hideable = (typeof ROLE_HIDEABLE_SALES_COLUMNS)[number];

const spec: ResponseVisibility<Hideable, ServicesSalesItem> = {
  page: "serviceSales",
  columns: ROLE_HIDEABLE_SALES_COLUMNS,
  isItem: (value): value is ServicesSalesItem => typeof value === "object" && value !== null && "salesStatus" in value && "quotationNo" in value,
  blank: (item, hidden) => ({
    ...item,
    client: hidden.has("client") ? { id: item.client.id, name: "" } : item.client,
    system: hidden.has("system") ? { description: "", typeId: null, typeName: null } : item.system,
    frequency: hidden.has("frequency") ? { code: "", label: "" } : item.frequency,
    service: hidden.has("service") ? { sequenceNo: 0, cycleNo: null, serviceCode: null } : item.service,
    serviceReportNo: hidden.has("serviceReportNo") ? null : item.serviceReportNo,
    serviceReport: hidden.has("serviceReport") ? null : item.serviceReport,
    serviceEngineer: hidden.has("serviceEngineer") ? null : item.serviceEngineer,
    salesEngineer: hidden.has("salesEngineer") ? null : item.salesEngineer,
    amcValue: hidden.has("amcValue") ? null : item.amcValue,
    serviceValue: hidden.has("serviceValue") ? null : item.serviceValue,
  }),
  listExtras: (list, hidden) => (hidden.has("amcValue") ? { ...without(list, ["amcValueTotal"]), amcValueTotal: null } : list),
};

export const applyServicesSalesVisibility = responseVisibility(spec);

export const salesHiddenColumns = (auth: Pick<AuthContext, "hidden">) => hiddenFor(auth, spec.page, spec.columns);

/** The hidden columns the export knows (it has no report-document column). */
export const salesExportHidden = (auth: Pick<AuthContext, "hidden">): ServicesSalesColumn[] =>
  [...salesHiddenColumns(auth)].filter((column) => column !== "serviceReport") as ServicesSalesColumn[];
