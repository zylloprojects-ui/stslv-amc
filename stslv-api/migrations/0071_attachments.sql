-- 0071_attachments
-- File attachments for AMC contracts (documents), procurement requests
-- (quotations) and project expenses (receipts and bills). Only metadata is
-- stored here; the file itself is held by the configured storage, under a
-- generated key, never under the name the user uploaded.
--
-- Versioned, never deleted: uploading a replacement adds a new version and
-- keeps the earlier ones. document_id groups the versions of one document
-- (it is the id of its first version).
--
-- PROVISIONAL (Q14): the categories, file types and size limit are a starting
-- point until the business confirms its document requirements.
--
-- To reverse (only while no file has been uploaded, and with approval):
--   DROP TABLE attachments;

CREATE TABLE attachments (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  document_id   bigint,
  version       integer     NOT NULL DEFAULT 1,
  is_current    boolean     NOT NULL DEFAULT true,
  entity_type   text        NOT NULL,
  entity_id     bigint      NOT NULL,
  category      text        NOT NULL,
  title         text        NOT NULL,
  original_name text        NOT NULL,
  mime_type     text        NOT NULL,
  size_bytes    bigint      NOT NULL,
  sha256        text        NOT NULL,
  storage_key   text        NOT NULL,
  notes         text,
  uploaded_by   bigint      NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachments_pk PRIMARY KEY (id),
  CONSTRAINT attachments_document_fk FOREIGN KEY (document_id) REFERENCES attachments (id) ON DELETE RESTRICT,
  CONSTRAINT attachments_uploaded_by_fk FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT attachments_entity_type_ck CHECK (entity_type IN ('amc_contracts', 'procurement_requests', 'project_expenses')),
  CONSTRAINT attachments_category_ck CHECK (category IN (
    'SIGNED_CONTRACT', 'LPO', 'PURCHASE_ORDER', 'CLIENT_APPROVAL', 'SERVICE_REPORT',
    'QUOTATION', 'DELIVERY_NOTE', 'RECEIPT', 'BILL', 'OTHER'
  )),
  CONSTRAINT attachments_version_ck CHECK (version >= 1),
  CONSTRAINT attachments_title_ck CHECK (btrim(title) <> ''),
  CONSTRAINT attachments_mime_ck CHECK (mime_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  CONSTRAINT attachments_size_ck CHECK (size_bytes > 0),
  CONSTRAINT attachments_sha256_ck CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT attachments_storage_key_uq UNIQUE (storage_key)
);

-- One current version per document, and version numbers unique within a document.
CREATE UNIQUE INDEX attachments_current_uq ON attachments (document_id) WHERE is_current;
CREATE UNIQUE INDEX attachments_document_version_uq ON attachments (document_id, version);
CREATE INDEX attachments_entity_idx ON attachments (entity_type, entity_id) WHERE is_current;
CREATE INDEX attachments_uploaded_by_idx ON attachments (uploaded_by);
