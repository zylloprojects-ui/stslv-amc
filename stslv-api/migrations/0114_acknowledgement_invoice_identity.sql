-- 0114_acknowledgement_invoice_identity
-- PREPARED FOR REVIEW (STS-ELV, Invoice Acknowledgements finalisation 2026-11-10). Applied to disposable databases
-- only. Forward-only; 0112 and 0113 are not modified.
--
-- One acknowledgement per actual INVOICE (0112 kept one per service). An invoice may cover several services.
--
-- Invoice identity (ack_invoices): one row per uniquely identified invoice.
--   basis 'ZOHO'    the invoice is an active Invoice Tracking record (invoices, 0060): zoho_invoice_id is its id, and its
--                   services are the visits that record is allocated to AND that carry the same Invoice No. on Accounts.
--                   The Zoho record is the authoritative identity (active numbers are unique there).
--   basis 'SERVICE' no Invoice Tracking record verifies it: the identity starts as one service's Invoice No. More
--                   services join it only by an explicit, reasoned, audited link (reconciliation). Equal numbers are
--                   NEVER merged automatically; they are flagged for an authorised user instead.
-- Service associations (ack_invoice_services): which service, with which Invoice No., belongs to which invoice.
--   (amc_visit_id, invoice_number) is unique: a service's number belongs to exactly one invoice. Rows are never
--   deleted; a service whose Invoice No. later changes keeps its old association as history (inactive, because the
--   service no longer carries that number), and its new number gets its own association.
-- Acknowledgements (invoice_acknowledgements, 0112) gain ack_invoice_id. ack_invoices.current_acknowledgement_id
--   names the one current acknowledgement of the invoice (unique). Earlier or conflicting acknowledgements stay
--   linked as history; nothing is deleted or reversed. amc_visit_id becomes optional: an invoice-level
--   acknowledgement has none; a 0112 (service-level) one keeps its service and number unchanged.
--
-- Existing data: NOTHING is rewritten here. Invoice identities and associations are created by the API's
-- synchronisation (deterministic, idempotent, audited), which also adopts each 0112 acknowledgement into its invoice:
-- exactly one acknowledgement with substance (confirmed, or with a document) becomes current; two or more mark the
-- invoice acknowledgement_conflict for an authorised user to resolve. Documents, dates, users and audit rows stay.
--
-- Reverse (only with approval, and only while ack_invoices is empty):
--   ALTER TABLE invoice_acknowledgements DROP COLUMN ack_invoice_id; restore amc_visit_id NOT NULL (only if no row lacks it);
--   DROP TABLE ack_invoice_services, ack_invoices; DROP FUNCTION ack_invoice_link_guard(), ack_acknowledgement_invoice_guard();

CREATE TABLE ack_invoices (
  id                         bigint      GENERATED ALWAYS AS IDENTITY,
  client_id                  bigint      NOT NULL,
  invoice_number             text        NOT NULL,
  basis                      text        NOT NULL,
  zoho_invoice_id            bigint,
  current_acknowledgement_id bigint,
  -- Set when an authorised user linked this invoice's services into another invoice (reconciliation). Kept as history.
  merged_into_id             bigint,
  -- Two or more acknowledgements with substance belong to this invoice; none is current until one is chosen.
  acknowledgement_conflict   boolean     NOT NULL DEFAULT false,
  -- An authorised user confirmed that invoices of this client with the same number are separate invoices.
  confirmed_separate         boolean     NOT NULL DEFAULT false,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ack_invoices_pk PRIMARY KEY (id),
  CONSTRAINT ack_invoices_client_fk FOREIGN KEY (client_id) REFERENCES clients_all (id) ON DELETE RESTRICT,
  CONSTRAINT ack_invoices_zoho_fk FOREIGN KEY (zoho_invoice_id) REFERENCES invoices (id) ON DELETE RESTRICT,
  CONSTRAINT ack_invoices_current_fk FOREIGN KEY (current_acknowledgement_id) REFERENCES invoice_acknowledgements (id) ON DELETE RESTRICT,
  CONSTRAINT ack_invoices_merged_fk FOREIGN KEY (merged_into_id) REFERENCES ack_invoices (id) ON DELETE RESTRICT,
  CONSTRAINT ack_invoices_number_ck CHECK (invoice_number <> '' AND invoice_number = btrim(invoice_number) AND length(invoice_number) <= 50),
  CONSTRAINT ack_invoices_basis_ck CHECK (basis IN ('ZOHO', 'SERVICE')),
  CONSTRAINT ack_invoices_zoho_ck CHECK ((basis = 'ZOHO') = (zoho_invoice_id IS NOT NULL)),
  CONSTRAINT ack_invoices_not_self_ck CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);

-- One live identity per Zoho record; one invoice per current acknowledgement.
CREATE UNIQUE INDEX ack_invoices_zoho_uq ON ack_invoices (zoho_invoice_id) WHERE zoho_invoice_id IS NOT NULL AND merged_into_id IS NULL;
CREATE UNIQUE INDEX ack_invoices_current_uq ON ack_invoices (current_acknowledgement_id) WHERE current_acknowledgement_id IS NOT NULL;
CREATE INDEX ack_invoices_number_idx ON ack_invoices (client_id, lower(invoice_number)) WHERE merged_into_id IS NULL;

CREATE TABLE ack_invoice_services (
  id             bigint      GENERATED ALWAYS AS IDENTITY,
  ack_invoice_id bigint      NOT NULL,
  amc_visit_id   bigint      NOT NULL,
  invoice_number text        NOT NULL,
  -- ZOHO: allocated by the Invoice Tracking record; SERVICE: the service's own invoice; LINKED: joined by an
  -- authorised reconciliation (linked_by, reason in the Audit Log).
  basis          text        NOT NULL,
  linked_by      bigint,
  linked_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ack_invoice_services_pk PRIMARY KEY (id),
  CONSTRAINT ack_invoice_services_invoice_fk FOREIGN KEY (ack_invoice_id) REFERENCES ack_invoices (id) ON DELETE RESTRICT,
  CONSTRAINT ack_invoice_services_visit_fk FOREIGN KEY (amc_visit_id) REFERENCES amc_visits_all (id) ON DELETE RESTRICT,
  CONSTRAINT ack_invoice_services_linked_by_fk FOREIGN KEY (linked_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT ack_invoice_services_basis_ck CHECK (basis IN ('ZOHO', 'SERVICE', 'LINKED')),
  CONSTRAINT ack_invoice_services_number_ck CHECK (invoice_number <> '' AND invoice_number = btrim(invoice_number) AND length(invoice_number) <= 50),
  CONSTRAINT ack_invoice_services_uq UNIQUE (amc_visit_id, invoice_number)
);

CREATE INDEX ack_invoice_services_invoice_idx ON ack_invoice_services (ack_invoice_id);

-- An association's service and number never change, and it is never deleted. Its invoice changes only through
-- reconciliation, never into an invoice of another client or another Invoice No.
CREATE FUNCTION ack_invoice_link_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Invoice service associations are history and cannot be deleted.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ack_invoice_link_guard';
  END IF;
  IF NEW.amc_visit_id IS DISTINCT FROM OLD.amc_visit_id OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number THEN
    RAISE EXCEPTION 'The service and Invoice No. of an invoice association cannot change.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ack_invoice_link_guard';
  END IF;
  IF NEW.ack_invoice_id IS DISTINCT FROM OLD.ack_invoice_id AND NOT EXISTS (
       SELECT 1 FROM ack_invoices a JOIN ack_invoices b ON b.id = OLD.ack_invoice_id
       WHERE a.id = NEW.ack_invoice_id AND a.client_id = b.client_id AND lower(a.invoice_number) = lower(b.invoice_number)) THEN
    RAISE EXCEPTION 'A service can only move to an invoice of the same client and Invoice No.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ack_invoice_link_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ack_invoice_link_guard
  BEFORE UPDATE OR DELETE ON ack_invoice_services
  FOR EACH ROW EXECUTE FUNCTION ack_invoice_link_guard();

-- Invoice identities are history too: never deleted; client and number never change.
CREATE FUNCTION ack_invoice_identity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Invoice identities are history and cannot be deleted.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ack_invoice_identity_guard';
  END IF;
  IF NEW.client_id IS DISTINCT FROM OLD.client_id OR lower(NEW.invoice_number) IS DISTINCT FROM lower(OLD.invoice_number) THEN
    RAISE EXCEPTION 'The client and Invoice No. of an invoice identity cannot change.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ack_invoice_identity_guard';
  END IF;
  IF OLD.zoho_invoice_id IS NOT NULL AND NEW.zoho_invoice_id IS DISTINCT FROM OLD.zoho_invoice_id THEN
    RAISE EXCEPTION 'An invoice verified by Invoice Tracking keeps its record.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ack_invoice_identity_guard';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER ack_invoice_identity_guard
  BEFORE UPDATE OR DELETE ON ack_invoices
  FOR EACH ROW EXECUTE FUNCTION ack_invoice_identity_guard();

ALTER TABLE invoice_acknowledgements
  ADD COLUMN ack_invoice_id bigint,
  ADD CONSTRAINT invoice_acknowledgements_ack_invoice_fk FOREIGN KEY (ack_invoice_id) REFERENCES ack_invoices (id) ON DELETE RESTRICT,
  ALTER COLUMN amc_visit_id DROP NOT NULL,
  ADD CONSTRAINT invoice_acknowledgements_subject_ck CHECK (amc_visit_id IS NOT NULL OR ack_invoice_id IS NOT NULL);

CREATE INDEX invoice_acknowledgements_ack_invoice_idx ON invoice_acknowledgements (ack_invoice_id) WHERE ack_invoice_id IS NOT NULL;

-- An acknowledgement's invoice is set once (on creation, or when a 0112 acknowledgement is adopted) and never moves.
CREATE FUNCTION ack_acknowledgement_invoice_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ack_invoice_id IS NOT NULL AND NEW.ack_invoice_id IS DISTINCT FROM OLD.ack_invoice_id THEN
    RAISE EXCEPTION 'Acknowledgement % already belongs to an invoice and cannot be moved.', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ack_acknowledgement_invoice_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ack_acknowledgement_invoice_guard
  BEFORE UPDATE OF ack_invoice_id ON invoice_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION ack_acknowledgement_invoice_guard();
