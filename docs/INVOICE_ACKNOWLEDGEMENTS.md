# Invoice Acknowledgements (Finance)

Status: implemented 2026-11-10 on `feature/sts-elv-client-fixes-20261109` (worktree `STSLV-AMC-client-fixes`), on top of 02a665c.
**Prepared for review: not pushed, not merged, not deployed.** Migrations 0112 and 0113 were applied to disposable databases only.

Client approval: the client approved a new Invoice Acknowledgements module under Finance (brief of 2026-11-10).

## 1. What it is

The client signs or stamps an acknowledgement that it received an invoice. This module keeps that document next to the invoice and shows, for every invoice, whether it is **Pending** or **Acknowledged** (green).

Route: **Finance → Invoice Acknowledgements**, `/finance/invoice-acknowledgements` (after Accounts; the other Finance entries are unchanged).

Acknowledgement is **not payment**. It changes no Invoice No., no Paid / Unpaid reference status, no amount, no service status, no Zoho record.

## 2. Invoice linkage design

STS-ELV has no standalone invoice table for AMC billing. The invoice Accounts shows is the **manual Invoice No. of a scheduled service** (`amc_visits_all.manual_invoice_no`, 0100), the approved source of the Paid reference status. Zoho records in Invoice Tracking (`invoices` / `invoice_allocations`, 0060) are secondary and optional.

- An invoice is identified by **(service id, Invoice No.)** — `invoice_acknowledgements (amc_visit_id, invoice_number)`, unique. The number alone is never a key: manual numbers are not unique (the same number may be typed on several services; a number may be corrected).
- The service fixes the **contract period**, so a renewal's invoice is linked to that renewal version (`STS-AMC-001 (V2)`), using the same `referenceSql` label as Accounts.
- The list is **Accounts' own rows**: same `FROM`, same scope (`IN_SCOPE` from Service Status: Recycle Bin and cancelled-contract rules included), restricted to services with an Invoice No. Nothing is copied into a second register.
- **Invoice Value** = the active Zoho amounts allocated to the service in Invoice Tracking, exactly Accounts' *Zoho Invoice Value*; **Service Value** = `visit_amount` (Accounts' *Value*). **Invoice Date** = the date of the active Zoho invoice with the same number covering the service. Cancelled Zoho invoices are ignored. When none exists the cell is empty: no date or amount is invented.
- **Corrected Invoice No.:** the earlier acknowledgement stays with the earlier number (kept, never rewritten); the new number is a new invoice and starts Pending. Cleared number: the row leaves the list (as on Accounts); the acknowledgement record is kept and reappears if the same number is entered again.
- Removing a service under an acknowledgement is refused (`ON DELETE RESTRICT`). In practice such services are completed and locked anyway.

## 3. Database (0112, 0113)

`0112_invoice_acknowledgements.sql`
- `role_permissions_module_ck` gains `INVOICE_ACKNOWLEDGEMENTS`.
- Table `invoice_acknowledgements`: `id`, `amc_visit_id` → `amc_visits_all`, `invoice_number` (trimmed, ≤ 50, as the manual number), `status` PENDING / ACKNOWLEDGED, `acknowledged_at`, `acknowledged_by` → `users`, `created_by`, `created_at`, `updated_at`. Check: acknowledged ⇔ date and user set. Unique `(amc_visit_id, invoice_number)`.
- `attachments`: new `entity_type 'invoice_acknowledgements'` and category `INVOICE_ACKNOWLEDGEMENT` (each only with the other); partial unique index `attachments_invoice_ack_uq` = one current document per acknowledgement.
- Triggers: a record starts PENDING; it can be confirmed only with a current document; once ACKNOWLEDGED it cannot be undone, re-dated or deleted; service and invoice number never change.
- Nothing existing is altered (verified by the upgrade test: visits, contracts, attachments and every other grant are byte-identical before and after).

`0113_seed_invoice_acknowledgement_permissions.sql` — Super Admin (`ADMIN`) receives all seven actions, as 0092 did for its modules. Idempotent. **No other role receives anything.**

## 4. Workflow

1. The invoice appears **Pending** (amber) as soon as its Invoice No. is entered on Accounts.
2. **Attach Acknowledgement** (Create) → **Choose document**. PDF, PNG or JPEG, recognised by content (never by name or browser type), name extension must match, ≤ `ATTACHMENT_MAX_MB` (12 MB). The file is stored at once in private storage and recorded as the current document of a PENDING acknowledgement. The dialog shows the **selected document name**. Status stays Pending ("Document attached, awaiting OK / Confirm").
3. **Choose a different file** adds a new version; **Remove** marks it not current (row and file kept). Both only before confirmation.
4. **OK / Confirm** sends the attachment id the user saw. The server reads the file back from storage, checks its SHA-256, then, in one transaction with the service row locked, sets ACKNOWLEDGED with `acknowledged_at = now()` and the user. A changed document, a missing file or a concurrent change → 409/404 and the invoice stays Pending.
5. **Acknowledged** shows in green (emerald badge, row tint) only from the server's answer; it persists across refresh and sessions.
6. **View Document** (View) opens a viewer fed by an authenticated `GET …/document` into a `blob:` URL (PDF in a frame, images inline); **Download** is inside the viewer. Earlier versions are listed.
7. **Replace Document** (Edit, acknowledged only): new version + reason (3–500 characters) in one request; the original acknowledged date and user stay; earlier version kept; reason in the Audit Log. Nothing is ever silently overwritten.

Delete is not offered: acknowledgements are retained evidence (no approved deletion rule exists).

## 5. Security and storage

- Private storage through the existing `FileStorage` (local folder, Supabase or R2): generated keys (`<uuid>.<ext>`), metadata in `attachments`, never a public or permanent URL, no storage key, checksum or credential in any response. Downloads: `Content-Disposition: attachment`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
- The file is validated before anything is stored; if the database save fails, the stored file is removed again (best effort) and nothing is recorded (tested with a forced database failure).
- Every route is behind `authenticate` + `authorize`; the document is served only for an invoice the list includes. Raw uploads limited to `ATTACHMENT_MAX_MB + 1` MB.
- Audit Log (`module INVOICE_ACKNOWLEDGEMENTS`, `entity_type invoice_acknowledgements`): `invoice_acknowledgement.document_uploaded`, `.document_removed`, `.confirmed`, `.document_replaced` (with reason), `invoice_acknowledgements.exported` — each written in the same transaction as the change.
- Amounts: `serviceValue`, `invoiceValue` and the totals are returned only to a role that also holds **Accounts: View** (the source page of those values); otherwise `null`, and the export leaves the amount columns out.

## 6. Permissions

| Action | Allows |
|---|---|
| View | Page, list, filters, document viewer and download, document history |
| Create | Attach, remove before confirming, OK / Confirm |
| Edit | Replace Document of an acknowledged invoice (with reason) |
| Export | Excel / PDF of the filtered list (with View) |

Starting grants (migration 0113): **Super Admin only.** Admin, Finance Executive, AMC Operations Executive, Master Data Executive and Viewer start with nothing, and the role model's `defaultGrants` keeps it that way (`NOT_SEEDED`, like Reports). Admin and Super Admin role-management safeguards are unchanged.

**Proposed grants, for owner approval (not applied):**

| Role | Proposed |
|---|---|
| Admin | View, Create, Edit, Export |
| Finance Executive | View, Create, Export (Edit only if Finance replaces documents) |
| Viewer | View |
| AMC Operations / Master Data Executive | none |

Super Admin can apply any of these in Administration → Roles & Permissions without a migration.

## 7. Accounts integration

- Same rows, numbers, links and values as Accounts (an API test compares them field by field).
- No change to Accounts' page, API, Paid logic, colours, totals or exports. No read-only acknowledgement indicator was added to Accounts, to keep its approved workflow untouched; it can be added later on request.
- Cancelled Zoho invoices never contribute a date or value (same rule as Accounts). No duplicate financial totals: the page's totals are PostgreSQL sums over the same filtered rows, shown only on this page.

## 8. Tests (2026-11-10, disposable database `stslv_amc_invoice_ack`)

- API: `tests/invoice-acknowledgements.test.ts` (25), `tests/migration-0112-upgrade.test.ts` (1); `database.test.ts` and `migration-0111-upgrade.test.ts` updated (new table; the 0111 step now copies only 0111 so later migrations do not enter it).
- Web: `src/test/invoice-acknowledgements.test.tsx` (17); `auth.test.tsx` Finance menu list updated.
- Browser E2E (headless Edge over CDP, isolated web 5411 → API 3411, schema `e2e_ack`, own JWT secret, temporary storage folder): 29/29.

## 9. Open points

1. Approve the starting grants in §6 (until then only Super Admin sees the page).
2. One invoice number typed on several services is one acknowledgement **per service** (the identity is the service plus its number). If the client issues one invoice covering several services, each row needs its own confirmation; a shared acknowledgement would need a separate decision.
3. Optional read-only acknowledgement indicator on Accounts (not added).
4. Releasing needs approval of 0112 and 0113 together with the branch's 0110 and 0111 (and 0108/0109 from the integration branch).
