-- 0112_invoice_acknowledgements
-- PREPARED FOR REVIEW (STS-ELV, Invoice Acknowledgements module approved by the client 2026-11-10). Applied to
-- isolated test databases only. A release applies it when the API starts, so releasing needs approval of this file.
--
-- Finance -> Invoice Acknowledgements: the client's signed or stamped acknowledgement that it received an invoice.
--
-- Which invoice: the one Accounts shows. STS-ELV has no standalone invoice table for AMC billing: the invoice of a
-- scheduled service is the manual Invoice No. entered on that service (amc_visits_all.manual_invoice_no, 0100, the
-- approved source of the Paid reference status). Invoice numbers are not guaranteed unique (the same number may be
-- typed on several services, and a number may be corrected), so the number alone is never a key. An acknowledgement
-- is identified by:
--     amc_visit_id   the scheduled service (its contract period, including a renewal version, follows from it)
--     invoice_number the Invoice No. that was acknowledged, exactly as it stood on the service
-- and (amc_visit_id, invoice_number) is unique: one acknowledgement record per invoice. If the Invoice No. of a service
-- is later corrected, the earlier acknowledgement stays with the earlier number (kept, never rewritten) and the new
-- number starts Pending. Zoho records in Invoice Tracking (0060) are only read, for the invoice date and value.
--
-- Status: PENDING (no document yet, or a document attached and awaiting OK / Confirm) or ACKNOWLEDGED. It is separate
-- from the Invoice No., the Paid reference status, cash receipt and service completion: nothing here changes a visit,
-- an invoice, a payment reference or an amount.
--
-- The document is an attachment (0071) with entity_type 'invoice_acknowledgements' and entity_id = this table's id,
-- category 'INVOICE_ACKNOWLEDGEMENT': metadata only, the file in the configured private storage under a generated key.
-- At most one current document per acknowledgement; a replacement adds a new version and keeps the earlier ones.
--
-- Database guards (the API refuses first with a clear message):
--   * an acknowledgement cannot be confirmed without a current document;
--   * once ACKNOWLEDGED it stays ACKNOWLEDGED, with its date and user, service and invoice number unchanged;
--   * the service and invoice number of a record never change;
--   * an ACKNOWLEDGED record cannot be deleted.
--
-- Nothing existing is changed: no visit, invoice, payment reference, amount or attachment row is altered.
-- Apply together with 0113 (Super Admin's grants for the new permission module).
--
-- Reverse (only with approval, and only while no acknowledgement exists):
--   DROP TABLE invoice_acknowledgements; DROP FUNCTION invoice_acknowledgements_guard(); DROP FUNCTION invoice_acknowledgements_no_delete();
--   DROP INDEX attachments_invoice_ack_uq;
--   ALTER TABLE attachments DROP CONSTRAINT attachments_invoice_ack_ck;
--   restore attachments_entity_type_ck and attachments_category_ck as 0104 and 0071 left them;
--   restore role_permissions_module_ck as 0091 left it (after deleting the grants of 0113).
-- Before that, check:
--   SELECT count(*) FROM invoice_acknowledgements; SELECT count(*) FROM attachments WHERE entity_type = 'invoice_acknowledgements';

ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_module_ck;

ALTER TABLE role_permissions
  ADD CONSTRAINT role_permissions_module_ck CHECK (module IN (
    'DASHBOARD', 'CLIENTS', 'AMC_CONTRACTS', 'AMC_SCHEDULE', 'AMC_EXECUTION',
    'PROJECTS', 'PROCUREMENT', 'EXPENSES', 'INVOICES', 'REPORTS', 'USERS', 'SETTINGS',
    'HISTORICAL_DATA', 'SERVICES_SALES',
    'AMC_RENEWAL', 'MONTHLY_CALENDAR', 'SERVICE_STATUS',
    'SALES_ENGINEERS', 'SYSTEM_TYPES', 'MAINTENANCE_FREQUENCIES', 'DEPARTMENTS',
    'MASTER_AMC_STATUS', 'ACCOUNTS', 'SUGGESTIONS', 'SUGGESTIONS_REVIEW',
    'INVOICE_ACKNOWLEDGEMENTS'
  ));

CREATE TABLE invoice_acknowledgements (
  id              bigint      GENERATED ALWAYS AS IDENTITY,
  amc_visit_id    bigint      NOT NULL,
  invoice_number  text        NOT NULL,
  status          text        NOT NULL DEFAULT 'PENDING',
  acknowledged_at timestamptz,
  acknowledged_by bigint,
  created_by      bigint      NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_acknowledgements_pk PRIMARY KEY (id),
  CONSTRAINT invoice_acknowledgements_visit_fk FOREIGN KEY (amc_visit_id) REFERENCES amc_visits_all (id) ON DELETE RESTRICT,
  CONSTRAINT invoice_acknowledgements_acknowledged_by_fk FOREIGN KEY (acknowledged_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT invoice_acknowledgements_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  -- The same trimmed text, at most 50 characters, as the manual Invoice No. it records.
  CONSTRAINT invoice_acknowledgements_invoice_number_ck CHECK (invoice_number <> '' AND invoice_number = btrim(invoice_number) AND length(invoice_number) <= 50),
  CONSTRAINT invoice_acknowledgements_status_ck CHECK (status IN ('PENDING', 'ACKNOWLEDGED')),
  CONSTRAINT invoice_acknowledgements_acknowledged_ck CHECK (
    (status = 'ACKNOWLEDGED') = (acknowledged_at IS NOT NULL)
    AND (status = 'ACKNOWLEDGED') = (acknowledged_by IS NOT NULL)
  ),
  -- One acknowledgement record per invoice (a service and its Invoice No.).
  CONSTRAINT invoice_acknowledgements_invoice_uq UNIQUE (amc_visit_id, invoice_number)
);

CREATE INDEX invoice_acknowledgements_status_idx ON invoice_acknowledgements (status);
CREATE INDEX invoice_acknowledgements_acknowledged_at_idx ON invoice_acknowledgements (acknowledged_at) WHERE acknowledged_at IS NOT NULL;

-- Documents: a new record type and category for attachments, held only by acknowledgements.
ALTER TABLE attachments
  DROP CONSTRAINT attachments_entity_type_ck,
  ADD CONSTRAINT attachments_entity_type_ck CHECK (entity_type IN ('amc_contracts', 'procurement_requests', 'project_expenses', 'amc_visits', 'invoice_acknowledgements'));

ALTER TABLE attachments
  DROP CONSTRAINT attachments_category_ck,
  ADD CONSTRAINT attachments_category_ck CHECK (category IN (
    'SIGNED_CONTRACT', 'LPO', 'PURCHASE_ORDER', 'CLIENT_APPROVAL', 'SERVICE_REPORT',
    'QUOTATION', 'DELIVERY_NOTE', 'RECEIPT', 'BILL', 'OTHER', 'INVOICE_ACKNOWLEDGEMENT'
  ));

ALTER TABLE attachments
  ADD CONSTRAINT attachments_invoice_ack_ck CHECK ((entity_type = 'invoice_acknowledgements') = (category = 'INVOICE_ACKNOWLEDGEMENT'));

-- One current document per acknowledgement, so two uploads at the same moment cannot both become current.
-- The API checks for this index to know that acknowledgements can be stored.
CREATE UNIQUE INDEX attachments_invoice_ack_uq ON attachments (entity_id)
  WHERE entity_type = 'invoice_acknowledgements' AND is_current;

CREATE FUNCTION invoice_acknowledgements_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amc_visit_id IS DISTINCT FROM OLD.amc_visit_id OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number THEN
    RAISE EXCEPTION 'The service and invoice number of acknowledgement % cannot change.', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_acknowledgements_guard';
  END IF;
  IF OLD.status = 'ACKNOWLEDGED' AND (
       NEW.status IS DISTINCT FROM 'ACKNOWLEDGED'
       OR NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
       OR NEW.acknowledged_by IS DISTINCT FROM OLD.acknowledged_by) THEN
    RAISE EXCEPTION 'Acknowledgement % is confirmed and cannot be undone or re-dated.', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_acknowledgements_guard';
  END IF;
  IF OLD.status = 'PENDING' AND NEW.status = 'ACKNOWLEDGED' AND NOT EXISTS (
       SELECT 1 FROM attachments a
       WHERE a.entity_type = 'invoice_acknowledgements' AND a.entity_id = NEW.id AND a.is_current) THEN
    RAISE EXCEPTION 'Acknowledgement % has no document and cannot be confirmed.', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_acknowledgements_guard';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoice_acknowledgements_guard
  BEFORE UPDATE ON invoice_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION invoice_acknowledgements_guard();

-- A record is only ever confirmed, never created already acknowledged without a document check.
CREATE FUNCTION invoice_acknowledgements_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'PENDING' THEN
    RAISE EXCEPTION 'An acknowledgement starts Pending and is confirmed afterwards.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_acknowledgements_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoice_acknowledgements_insert_guard
  BEFORE INSERT ON invoice_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION invoice_acknowledgements_insert_guard();

CREATE FUNCTION invoice_acknowledgements_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'ACKNOWLEDGED' THEN
    RAISE EXCEPTION 'Acknowledgement % is confirmed evidence and cannot be deleted.', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_acknowledgements_guard';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER invoice_acknowledgements_no_delete
  BEFORE DELETE ON invoice_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION invoice_acknowledgements_no_delete();
