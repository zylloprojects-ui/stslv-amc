-- 0010_amc_contracts
-- AMC contract master. One row is one maintenance agreement with a client for
-- one system over a validity period. The visit schedule (0011) is generated
-- from valid_from, valid_to and maintenance_frequency.
--
-- Money is numeric(14,3): the client's workbooks record three decimal places.
--
-- Deliberately absent (not confirmed by the client):
--   * contract number / client code  - none exists in the legacy data.
--   * system type lookup             - granularity is unresolved (Q15); the
--                                      system is stored as text.
--   * link from engineer to a user   - unresolved (Q20); stored as a name.
--   * billing frequency              - unresolved (Q3).

CREATE TABLE amc_contracts (
  id                    bigint GENERATED ALWAYS AS IDENTITY,
  client_id             bigint        NOT NULL,
  -- Name of the responsible engineer / person, as written by the business.
  responsible_engineer  text,
  valid_from            date          NOT NULL,
  valid_to              date          NOT NULL,
  -- The maintained system or service, for example "FIRE" or "CCTV".
  system_description    text          NOT NULL,
  description           text,
  contract_value        numeric(14,3) NOT NULL,
  -- The legacy "FINAL CREDIT" figure. Its meaning is unconfirmed (Q1): it is
  -- stored exactly as entered and takes part in no calculation or validation.
  final_credit          numeric(14,3),
  maintenance_frequency text          NOT NULL,
  -- Starting amount copied to each generated visit. Null means "no default":
  -- visits are then generated without an amount. Every visit amount can be
  -- changed independently afterwards.
  default_visit_amount  numeric(14,3),
  status                text          NOT NULL DEFAULT 'DRAFT',
  notes                 text,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  -- Null only for rows not created by a signed-in user (for example a future import).
  created_by            bigint,
  updated_by            bigint,
  CONSTRAINT amc_contracts_pk PRIMARY KEY (id),
  CONSTRAINT amc_contracts_client_id_fk FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT,
  CONSTRAINT amc_contracts_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT amc_contracts_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT amc_contracts_validity_ck CHECK (valid_to >= valid_from),
  CONSTRAINT amc_contracts_system_description_ck CHECK (btrim(system_description) <> ''),
  CONSTRAINT amc_contracts_contract_value_ck CHECK (contract_value >= 0),
  CONSTRAINT amc_contracts_final_credit_ck CHECK (final_credit IS NULL OR final_credit >= 0),
  CONSTRAINT amc_contracts_default_visit_amount_ck CHECK (default_visit_amount IS NULL OR default_visit_amount >= 0),
  CONSTRAINT amc_contracts_maintenance_frequency_ck CHECK (
    maintenance_frequency IN ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUALLY')
  ),
  CONSTRAINT amc_contracts_status_ck CHECK (status IN ('DRAFT', 'ACTIVE', 'EXPIRED', 'CANCELLED'))
);

CREATE INDEX amc_contracts_client_id_idx ON amc_contracts (client_id);
CREATE INDEX amc_contracts_status_idx ON amc_contracts (status);
CREATE INDEX amc_contracts_valid_to_idx ON amc_contracts (valid_to);
CREATE INDEX amc_contracts_created_by_idx ON amc_contracts (created_by);
CREATE INDEX amc_contracts_updated_by_idx ON amc_contracts (updated_by);

CREATE TRIGGER amc_contracts_set_updated_at
  BEFORE UPDATE ON amc_contracts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
