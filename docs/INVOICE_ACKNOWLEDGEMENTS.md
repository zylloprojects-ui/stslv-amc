# Invoice Acknowledgements (Finance)

Status: implemented 2026-11-10 on `feature/sts-elv-client-fixes-20261109` (worktree `STSLV-AMC-client-fixes`): first
version 8fbdeff (one acknowledgement per service), finalised to **one acknowledgement per invoice** in the following
commit (81788d0), then completed with cancelled-record re-association (0116) and the read-only Accounts indicator.
**Prepared for review: not pushed, not merged, not deployed.** Migrations 0112–0116 were applied to disposable
databases only.

Route: **Accounts → Invoice Ack** in the sidebar (since 2026-11-10; formerly Finance → Invoice Acknowledgements), `/finance/invoice-acknowledgements`, after Invoices.

Acknowledgement is **not payment**. It changes no Invoice No., no Paid / Unpaid reference status, no amount, no
service status and no Invoice Tracking record.

## 1. Invoice identity

STS-ELV keeps two kinds of invoice reference:

- the **manual Invoice No.** on each service (`amc_visits_all.manual_invoice_no`, 0100) — the approved source of Paid /
  Unpaid on Accounts; not unique (one invoice may cover several services, and a number can be repeated or corrected);
- **Invoice Tracking records** (`invoices` + `invoice_allocations`, 0060) — optional; an active record's number is unique
  and its allocations name exactly the services it covers.

Neither alone identifies every invoice, so 0114 adds a normalised identity, **`ack_invoices`**, with explicit
service associations, **`ack_invoice_services`**:

| basis | when | services |
|---|---|---|
| `ZOHO` | an active Invoice Tracking record of the same client and number (case ignored) is allocated to the service | every service that record is allocated to **and** that carries the same Invoice No. on Accounts; `zoho_invoice_id` is the record (one live identity per record) |
| `SERVICE` | no record verifies it | the one service; more services join only through an authorised, reasoned **link** |

- `(amc_visit_id, invoice_number)` is unique in the associations: a service's number belongs to exactly one invoice.
- The invoice number alone is never a key. **Equal numbers are never merged automatically.** Two live invoices of one
  client with the same number are flagged **SAME_NUMBER** for reconciliation. Equal numbers of different clients are
  separate invoices and are not flagged.
- An invoice is **listed** while at least one of its services is in Accounts' scope and still carries its number.
  Associations are never deleted: a corrected Invoice No. leaves the old association as history and gets a new one.
  If the old number returns, the old invoice and its acknowledgement come back.
- The contract period (including renewal version, e.g. `STS-AMC-001 (V2)`) comes from each linked service.
- A `SERVICE` invoice is upgraded to `ZOHO` when every one of its services is later allocated to one active record. It
  joins an existing `ZOHO` invoice only if it has no acknowledgement work of its own; otherwise it stays flagged.
- Invoice Tracking records cancelled after identification stay attached and contribute no date or value. The invoice
  shows the warning **ZOHO_CANCELLED** ("Invoice Tracking record cancelled"); it does not block acknowledgement.
- **Re-association (0116):** when the invoice is re-entered as a new Invoice Tracking record, an Edit user can point the
  same invoice identity to it (`POST /:invoiceId/reassociate`, reason required, audited as
  `invoice_acknowledgement.invoice_record_reassociated`). Only an ISSUED record of the same client and number that is
  allocated to **every** active service of the invoice, and held by no other invoice, is offered as verified; others
  are listed with the reason they cannot be used. The database allows the record to change only from CANCELLED to an
  ISSUED record of the same client and number. The invoice id, services, acknowledgement and history never change,
  and nothing is re-associated automatically.

The synchronisation (`invoice-sync.ts`) runs before every read and write: one transaction, one advisory lock,
deterministic and idempotent.

## 2. Acknowledgements and history

- `invoice_acknowledgements.ack_invoice_id` (0114) ties an acknowledgement to its invoice; once set it never moves.
- `ack_invoices.current_acknowledgement_id` names the invoice's one current acknowledgement (unique across invoices).
- New acknowledgements are invoice-level (`amc_visit_id` null). One document and one confirmation acknowledge every
  linked service.
- **Earlier per-service (0112) acknowledgements** are adopted into the invoice of their service and number. Exactly one
  with substance (confirmed, or with a document) becomes current, keeping its date, user and documents. Two or more are
  **all kept**, none is chosen, and the invoice is flagged **CONFLICTING_ACKNOWLEDGEMENTS**. Adoption and flags are
  audited (`invoice_acknowledgement.adopted`, `.conflict_flagged`).
- A link that brings two acknowledged invoices together also flags the conflict rather than choosing one.
- Database guards:
  - associations and identities cannot be deleted;
  - service, number, client and number of an identity never change;
  - a service can move only to an invoice of the same client and Invoice No.;
  - a verified identity keeps its record;
  - 0112's guards still apply: confirm needs a document, and there is no undo, re-date or delete of a confirmed acknowledgement.

## 3. Workflow

1. Pending (amber).
2. **Attach Acknowledgement** (Create): PDF/PNG/JPEG checked by content, ≤ 12 MB, stored privately at once; the name is
   shown; still Pending.
3. **OK / Confirm** (Create): the server reads the file back and checks its SHA-256, then locks the invoice and its
   acknowledgement and sets **Acknowledged** (green) with date/time and user. Two simultaneous confirmations: one
   succeeds, the other is refused.
4. **View Document / Download** (View): authenticated fetch into a `blob:` URL. **Document history** lists every version,
   each downloadable, only for this invoice (and invoices linked into it).
5. **Replace Document** (Edit): new version with a reason; original date and user kept; earlier version kept; audited.
6. **Linked Services** (View): the services the invoice covers, with how each was linked; values only with Accounts: View.
7. **Reconcile** (Edit, reason required, audited):
   - **Link as one invoice**: same client and number only. Two Invoice Tracking records are never linked. The Invoice
     Tracking invoice survives if one exists; the other is kept as history.
   - **They are separate invoices**: the SAME_NUMBER flag clears.
   - **Make current**: choose the current one of conflicting acknowledgements; the others stay in history.
   - While flagged, the invoice takes no new attachment or confirmation.

## 4. Permissions (approved defaults)

| Role | Invoice Acknowledgements |
|---|---|
| Super Admin | View, Create, Edit, Export (0113 grants every action, as for every module) |
| Admin | View, Create, Edit, Export (0115) |
| Finance Executive | View, Create, Export (0115) |
| Viewer, AMC Operations, Master Data, custom roles | none |

- 0115 is insert-only and idempotent: it never removes or changes an existing grant, so customised roles keep what they hold.
- Amounts (`invoiceValue`, `serviceValue`, totals, linked-service values, export columns) additionally require **Accounts: View**.
- Every route checks permissions server-side.

## 5. Security

- Private storage only, with generated keys. There are no public URLs and no storage keys, checksums or credentials in responses.
- Files are validated before anything is stored. A failed save removes the stored file again (tested).
- Documents are served only through the invoice they belong to. Another invoice's attachment id gets a 404.
- Services move between invoices only by an Edit-authorised, reasoned link, and the database refuses moves across clients or numbers.
- Audit Log entries:
  - document actions: upload, removal, confirmation, replacement, export;
  - invoice actions: adoption, conflict, link, separate, choice, and system verification by Invoice Tracking.

## 6. Accounts integration

- Same services, numbers, contract periods and values as Accounts. A test checks that every Accounts service with an
  Invoice No. is linked to exactly one listed invoice carrying that number.
- **Invoice value is counted once per invoice** (the Invoice Tracking amount), never per service. Service value is the
  sum of the invoice's own services.
- Accounts' Paid logic, colours, totals, filters and exports are unchanged. One read-only addition: users who also hold
  Invoice Acknowledgements: View see **Ack: Acknowledged / Pending** under the Invoice No. (`acknowledgementStatus` in
  `GET /api/accounts`, null for everyone else; not in the export).

## 7. Tests (disposable database `stslv_amc_invoice_ack`)

- API, `tests/invoice-acknowledgements.test.ts`. It covers:
  - multi-service invoice, several invoices on one contract, equal numbers within a client and across clients;
  - renewal version;
  - pending → acknowledged, a confirmation race, replacement and history;
  - cross-invoice document refusal;
  - link and separate, conflicting legacy acknowledgements and choice, single legacy adoption;
  - the role matrix and financial restriction;
  - database guards, failure cleanup, corrected Invoice No., filters and export.
- API cancelled-record tests: warning without block, no automatic change, verified and unverified replacements,
  Edit-only with reason, audit, database guard. Accounts indicator: shown only with Invoice Acknowledgements: View.
- `tests/migration-0114-upgrade.test.ts`: 0113 → 0114/0115/0116 with legacy acknowledgements, a customised role, idempotency.
- Web, `src/test/invoice-acknowledgements.test.tsx`; isolated browser E2E (desktop and mobile).

## 8. Open points

1. Super Admin's 0113 grant also includes the unused Delete/Approve/Read actions (Super Admin holds every action of
   every module); they enable nothing.
2. A re-entered record that covers only some of the invoice's services cannot be verified and is not offered; the
   client decides whether such a split should become separate invoices (no rule exists yet).
3. Releasing needs approval of 0112–0116 with the branch's 0110/0111 (and 0108/0109 from the integration branch).
