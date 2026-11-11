/**
 * True when a contract (aliased "c") has neither a Billing Basis nor a Cost per Visit, so its services have no value
 * source. Master AMC Status and Service Status both use it to explain a missing service value the same way.
 */
export const NO_AMOUNT_SOURCE_SQL = "(c.billing_basis IS NULL AND c.default_visit_amount IS NULL)";
