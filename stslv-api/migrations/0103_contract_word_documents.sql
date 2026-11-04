-- 0103_contract_word_documents
-- A new AMC contract must carry its contract document (Add AMC Contract,
-- 2026-11-03), which may be a PDF or a Word file (.doc or .docx). Until now
-- attachments accepted PDF, PNG and JPEG only (0071, provisional Q14).
--
-- Widens the file-type check so Word documents can be stored. Which record
-- types may hold them is decided in the API (AMC contracts only); the check
-- here lists every type any record may hold. Nothing else changes: no table,
-- column, row or file is altered.
--
-- Number: 0102 is taken by the Sales Engineers code session
-- (feature/sales-engineers-code-delete), so this is 0103.
--
-- To reverse (only while no Word document has been uploaded, and with approval):
--   ALTER TABLE attachments DROP CONSTRAINT attachments_mime_ck,
--     ADD CONSTRAINT attachments_mime_ck CHECK (mime_type IN ('application/pdf', 'image/png', 'image/jpeg'));
-- Before that, check:
--   SELECT count(*) FROM attachments WHERE mime_type NOT IN ('application/pdf', 'image/png', 'image/jpeg');

ALTER TABLE attachments
  DROP CONSTRAINT attachments_mime_ck,
  ADD CONSTRAINT attachments_mime_ck CHECK (mime_type IN (
    'application/pdf',
    'image/png',
    'image/jpeg',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ));
