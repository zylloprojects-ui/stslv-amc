-- Paid-but-not-Completed review (P1 fixes, 2026-11-09). READ ONLY.
--
-- Lists every service that carries a manual Invoice No. (reference status Paid) but whose stored status is
-- not Completed: numbers entered before the 2026-11-04 "complete first" rule. The owner approved keeping
-- these records exactly as they are (no automatic completion, cancellation or clearing). This query only
-- identifies them for a person to review.
--
-- NOT RUN AGAINST PRODUCTION. Running it on production needs explicit approval. When approved, run it in
-- a read-only transaction, for example in psql:
--
--   BEGIN TRANSACTION READ ONLY;
--   \i docs/sql/paid-not-completed-review.sql
--   ROLLBACK;
--
-- Contracts in the Recycle Bin and their services are outside the amc_contracts / amc_visits views and
-- are not listed. The statement below is a single SELECT; it changes nothing.
SELECT c.amc_reference                    AS amc_reference,
       cl.name                            AS client,
       c.system_description               AS system,
       c.status                           AS contract_status,
       c.valid_to                         AS contract_valid_to,
       v.id                               AS visit_id,
       v.sequence_no                      AS visit_no,
       v.scheduled_date                   AS scheduled_date,
       v.status                           AS visit_status,
       v.manual_invoice_no                AS invoice_no,
       v.manual_invoice_at                AS invoice_no_entered_at,
       v.visit_amount                     AS visit_amount_omr_ex_vat,
       CASE
         WHEN c.status = 'CANCELLED' THEN 'Paid service on a cancelled contract'
         WHEN v.status = 'CANCELLED' THEN 'Paid service that is itself cancelled'
         ELSE 'Paid service not yet completed'
       END                                AS exception
FROM amc_visits v
JOIN amc_contracts c ON c.id = v.amc_contract_id
JOIN clients cl ON cl.id = c.client_id
WHERE v.manual_invoice_no IS NOT NULL
  AND v.status <> 'COMPLETED'
ORDER BY lower(cl.name), c.amc_reference, v.scheduled_date, v.id
