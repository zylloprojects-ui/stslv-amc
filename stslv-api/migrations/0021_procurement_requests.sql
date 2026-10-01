-- 0021_procurement_requests
-- One row per procurement requirement on a project / job.
--
-- A quotation amount is a commitment, not a recorded cost: job cost comes
-- only from project_expenses.
--
-- Supplier is free text. A supplier master is not approved for Phase 1
-- (open question Q16). No approval chain exists (Q12). Quotation files are
-- not stored yet: there is no attachment infrastructure (Q14).

CREATE TABLE procurement_requests (
  id                     bigint GENERATED ALWAYS AS IDENTITY,
  project_id             bigint        NOT NULL,
  -- The team's own request reference, where they use one.
  reference              text,
  -- What is needed.
  description            text          NOT NULL,
  request_date           date          NOT NULL,
  supplier_name          text,
  quotation_reference    text,
  quotation_date         date,
  quotation_amount       numeric(14,3),
  po_reference           text,
  order_date             date,
  expected_delivery_date date,
  delivered_date         date,
  status                 text          NOT NULL DEFAULT 'REQUESTED',
  notes                  text,
  created_at             timestamptz   NOT NULL DEFAULT now(),
  updated_at             timestamptz   NOT NULL DEFAULT now(),
  created_by             bigint,
  updated_by             bigint,
  CONSTRAINT procurement_requests_pk PRIMARY KEY (id),
  CONSTRAINT procurement_requests_description_ck CHECK (btrim(description) <> ''),
  CONSTRAINT procurement_requests_quotation_amount_ck CHECK (quotation_amount IS NULL OR quotation_amount >= 0),
  -- PROVISIONAL status list (open question Q8).
  CONSTRAINT procurement_requests_status_ck CHECK (status IN ('REQUESTED', 'QUOTED', 'ORDERED', 'DELIVERED', 'CANCELLED')),
  CONSTRAINT procurement_requests_delivered_date_ck CHECK (status <> 'DELIVERED' OR delivered_date IS NOT NULL),
  CONSTRAINT procurement_requests_project_id_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT procurement_requests_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT procurement_requests_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX procurement_requests_project_id_idx ON procurement_requests (project_id);
CREATE INDEX procurement_requests_status_idx ON procurement_requests (status);
CREATE INDEX procurement_requests_created_by_idx ON procurement_requests (created_by);
CREATE INDEX procurement_requests_updated_by_idx ON procurement_requests (updated_by);

CREATE TRIGGER procurement_requests_set_updated_at
  BEFORE UPDATE ON procurement_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
