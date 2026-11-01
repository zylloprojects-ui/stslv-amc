-- 0093_contract_billing_basis
-- PREPARED FOR REVIEW. Not applied to stslv_amc_dev or Neon; tested on isolated
-- databases only. A release of this branch applies it when the API starts, so
-- releasing needs approval of this file too.
--
-- Records which amount a contract is billed on. It is a record only: no
-- calculation reads it, and visit amounts still come from default_visit_amount
-- (Cost per Visit). The formula and rounding are not yet confirmed by the client.
--
--   * Nullable, no default: existing contracts stay "not set"; no value changes.
--   * CONTRACT_VALUE = amc_contracts.contract_value
--     FINAL_CREDIT   = amc_contracts.final_credit
--     CUSTOM         = amc_contracts.custom_billing_value, entered by hand
--
-- Reverse (only with approval, and it loses recorded choices):
--   ALTER TABLE amc_contracts DROP CONSTRAINT amc_contracts_billing_basis_ck,
--     DROP CONSTRAINT amc_contracts_custom_billing_ck,
--     DROP COLUMN billing_basis, DROP COLUMN custom_billing_value;

ALTER TABLE amc_contracts
  ADD COLUMN billing_basis text,
  ADD COLUMN custom_billing_value numeric(14,3),
  ADD CONSTRAINT amc_contracts_billing_basis_ck CHECK (billing_basis IN ('CONTRACT_VALUE', 'FINAL_CREDIT', 'CUSTOM')),
  ADD CONSTRAINT amc_contracts_custom_billing_ck CHECK (
    (billing_basis = 'CUSTOM' AND custom_billing_value IS NOT NULL AND custom_billing_value >= 0)
    OR (billing_basis IS DISTINCT FROM 'CUSTOM' AND custom_billing_value IS NULL)
  );
