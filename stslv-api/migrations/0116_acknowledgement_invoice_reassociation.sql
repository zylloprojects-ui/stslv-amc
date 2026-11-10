-- 0116_acknowledgement_invoice_reassociation
-- PREPARED FOR REVIEW (STS-ELV, 2026-11-10). Applied to disposable databases only. Forward-only; 0114 is not modified.
--
-- An invoice identity verified by an Invoice Tracking record (ack_invoices.basis 'ZOHO', 0114) keeps that record. When
-- the record is CANCELLED in Invoice Tracking and re-entered as a new record, the invoice and its acknowledgement are
-- the same; only the record changed. 0114 refused any change of zoho_invoice_id. This replaces its guard so that the
-- record may change in exactly one case:
--   * the current record is CANCELLED, and
--   * the new record is ISSUED (active), of the same client, with the same invoice number (case ignored).
-- The API adds the rest (an Edit user, a reason, every linked service allocated to the new record, an Audit Log entry)
-- and never does it automatically. The invoice identity (id), its services and its acknowledgements are unchanged.
-- Everything else 0114 guarded stays guarded: no delete, client and number never change.
--
-- Reverse (only with approval): re-create ack_invoice_identity_guard() exactly as in 0114.

CREATE OR REPLACE FUNCTION ack_invoice_identity_guard() RETURNS trigger
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
  IF OLD.zoho_invoice_id IS NOT NULL AND NEW.zoho_invoice_id IS DISTINCT FROM OLD.zoho_invoice_id AND NOT EXISTS (
       SELECT 1
       FROM invoices old_record, invoices new_record
       WHERE old_record.id = OLD.zoho_invoice_id AND old_record.status = 'CANCELLED'
         AND new_record.id = NEW.zoho_invoice_id AND new_record.status = 'ISSUED'
         AND new_record.client_id = OLD.client_id AND lower(new_record.invoice_number) = lower(OLD.invoice_number)) THEN
    RAISE EXCEPTION 'An invoice verified by Invoice Tracking keeps its record, unless that record is cancelled and replaced by an active record of the same client and number.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ack_invoice_identity_guard';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
