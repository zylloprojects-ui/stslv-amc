-- 0074_client_details
-- Two optional client fields: whether the client is a company or an
-- individual, and its VAT number.
--
-- Additive only: both columns are null for every existing client until a user
-- fills them in. Nothing is derived or filled automatically. The VAT number is
-- not required to be unique (that rule is not confirmed).
--
-- To reverse (with approval): ALTER TABLE clients DROP COLUMN client_type, DROP COLUMN vat_number;

ALTER TABLE clients
  ADD COLUMN client_type text,
  ADD COLUMN vat_number  text,
  ADD CONSTRAINT clients_client_type_ck CHECK (client_type IS NULL OR client_type IN ('COMPANY', 'INDIVIDUAL')),
  ADD CONSTRAINT clients_vat_number_ck CHECK (vat_number IS NULL OR btrim(vat_number) <> '');

CREATE INDEX clients_vat_number_idx ON clients (lower(vat_number)) WHERE vat_number IS NOT NULL;
