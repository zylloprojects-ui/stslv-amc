# API Reference — STSLEV AMC

Express 5 REST API in `stslv-api`, mounted under `/api` (`src/app.ts`). Described at commit `c6d8d19`. Routes are in `src/modules/<module>/<module>.routes.ts`; validation schemas beside them (Zod).

## 1. Conventions

**Success:** `{ "success": true, "data": … }`.
**Error:** `{ "success": false, "error": { "code", "message", "details"?: [{ "field", "message" }] } }` (`src/shared/errors.ts`). Stack traces and internal errors are never returned.

| Code | HTTP | Meaning |
|---|---|---|
| VALIDATION_ERROR | 400 | Invalid fields ("Some fields are invalid."), with `details` |
| INVALID_JSON | 400 | Body is not JSON |
| UNAUTHORIZED | 401 | No or invalid token |
| INVALID_CREDENTIALS | 401 | Sign-in failed ("Incorrect email or password.") |
| TEMPORARY_PASSWORD_EXPIRED | 401 | Temporary password older than 15 minutes |
| FORBIDDEN | 403 | Permission missing |
| PASSWORD_CHANGE_REQUIRED | 403 | Temporary-password session used elsewhere than the allowed routes |
| NOT_FOUND / METHOD_NOT_ALLOWED | 404 / 405 | |
| CONFLICT | 409 | Business rule or concurrent change (e.g. completion lock, duplicate number, Recycle Bin codes RB001/RB002) |
| PAYLOAD_TOO_LARGE | 413 | Body over the limit |
| TOO_MANY_REQUESTS | 429 | Rate limit |
| FEATURE_UNAVAILABLE | 503 | A required migration is not applied |
| BACKUP_UNAVAILABLE / STORAGE_ERROR | 503 | Backups not configured / document store unreachable |
| INTERNAL_ERROR | 500 | Logged on the server only |

**Authentication:** `Authorization: Bearer <JWT>` (HS256, `JWT_SECRET` ≥ 32 characters, lifetime `JWT_EXPIRES_IN`, default 8h, allowed 1 minute–7 days). The token carries only the user id (and a flag for a temporary-password session). User, roles and permissions are reloaded from the database on every request; a token is refused when the user is inactive or the token predates the last password change. Logout records the event; it does not revoke the token.

**Authorisation notation:** `P(M,A)` = permission *Module:Action*; `Any([M…],A)` = that action on any listed module; `Read(M)` = View or data-only Read; **Admin** = Super Admin or Admin; **SA** = Super Admin (often checked in the service). Every action also requires View of the module.

**Limits:** JSON bodies 100 kB (except `POST /api/amc/contracts`, which carries the document). Rate limits per 15 minutes, in memory (reset on restart): sign-in 50 per address (`LOGIN_RATE_LIMIT`), failed sign-ins 5 per address+email (`LOGIN_FAILURE_LIMIT`), sign-up 10 per address (`PUBLIC_AUTH_RATE_LIMIT`), temporary passwords 10 per administrator (`TEMPORARY_PASSWORD_RATE_LIMIT`). Security headers always; HSTS in production; CORS limited to `CORS_ORIGIN`.

**Exports:** `…/export?format=xlsx|pdf` (only these two). Exports cover every filtered row.

## 2. Endpoints

### Health (public)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | Always 200 when the process runs |
| GET | `/api/health/database` | 503 when the database does not answer |

### Auth — `/api/auth`
| Method | Path | Access |
|---|---|---|
| POST | `/login` | Public, rate-limited |
| POST | `/signup` | Public, rate-limited; 202, account pending |
| GET | `/me` | Signed in (temporary session allowed) |
| POST | `/logout` | Signed in (temporary session allowed); revokes this session on the server (0108) |
| POST | `/logout-all` | Signed in (temporary session allowed); revokes every session of the account |
| GET | `/sessions` | Signed in — own open sessions |
| DELETE | `/sessions/:sessionId` | Signed in — revoke one of own sessions |
| POST | `/complete-password-change` | Temporary session |
| POST | `/change-password` | Signed in |

### Users — `/api/users`
| Method | Path | Access |
|---|---|---|
| GET | `/` | P(USERS,VIEW) |
| GET | `/export` | P(USERS,VIEW) + Admin |
| POST | `/` | P(USERS,CREATE) |
| PATCH | `/:id` | P(USERS,EDIT) — name |
| POST | `/:id/activate` | USERS EDIT, or APPROVE for a pending account |
| POST | `/:id/deactivate` | P(USERS,EDIT) |
| POST | `/:id/reject` | P(USERS,APPROVE) |
| PUT | `/:id/roles` | P(USERS,EDIT); privileged roles SA only |
| POST | `/:id/temporary-password` | P(USERS,EDIT) + Admin; rate-limited; `Cache-Control: no-store` |
| GET | `/:id/sessions` | P(USERS,VIEW) — that user's open sessions |
| POST | `/:id/sessions/revoke` | P(USERS,EDIT) — sign the user out everywhere (user-management rules apply) |
| DELETE | `/:id/sessions/:sessionId` | P(USERS,EDIT) — revoke one session |

### Roles — `/api/roles`
| Method | Path | Access |
|---|---|---|
| GET | `/` | P(USERS,VIEW) — roles (with `permissionsEditable`, `lockedReason`, `manageable`, `manageReason`, `assignable`), `canManageRoles`, catalog, fixed access |
| POST | `/` · PATCH `/:id` · DELETE `/:id` | SA, or Admin with P(USERS,EDIT): custom roles only, within Admin's own permissions, never its own role (2026-11-09) |
| PUT | `/:id/permissions` | Same as above; Admin cannot add USERS permissions; body has `expectedVersion` (refused if changed meanwhile) |

### Audit — `/api/audit`
| Method | Path | Access |
|---|---|---|
| GET | `/logins` | P(USERS,VIEW) |
| GET | `/logins/export` | P(USERS,VIEW) + Admin |
| GET | `/activity`, `/activity/export`, `/activity/options` | Admin |

### Security — `/api/security` (all Admin)
| Method | Path | Notes |
|---|---|---|
| GET | `/overview`, `/events`, `/deletions`, `/deletions/export` | Security Center, Deletion History |
| GET | `/sessions` | Every open session (0108), for Security Center → Active sessions |
| GET | `/recycle-bin`, `/recycle-bin/amc-contracts`, `/recycle-bin/:type/:id/check` | SA |
| POST | `/recycle-bin/:type/:id/restore` | SA |
| DELETE | `/recycle-bin/:type/:id` | SA, body `{confirm}`; refused for contracts |
| GET | `/backups` | Status |
| POST | `/backups` | SA; 202 |
| GET | `/backups/:id/download` | SA; checksum verified first |

### Dashboard — `/api/dashboard`
`GET /summary`, `/operations`, `/calendar` — P(DASHBOARD,VIEW) (sections filtered by module permissions). `GET /readiness` — + Admin.

### Clients — `/api/clients`
| Method | Path | Access |
|---|---|---|
| GET | `/` | Read(CLIENTS) |
| GET | `/features`, `/:id`, `/:id/summary`, `/:id/history`, `/:id/usage` | P(CLIENTS,VIEW) |
| GET | `/export` | CLIENTS VIEW + EXPORT |
| GET | `/:id/contracts/export` | CLIENTS VIEW + AMC_CONTRACTS VIEW + EXPORT |
| POST | `/` | CREATE |
| PATCH | `/:id` | EDIT |
| POST | `/:id/deactivate`, `/:id/reactivate` | DELETE |
| DELETE | `/:id` | DELETE + SA — to Recycle Bin |

### AMC — `/api/amc`
**Summaries / renewals**
| Method | Path | Access |
|---|---|---|
| GET | `/summary` | any AMC view |
| GET | `/management/summary`, `/reports/expiring` | AMC_CONTRACTS VIEW |
| GET | `/renewals/queue`, `/reports/renewals` (+ `/export`) | AMC_RENEWAL VIEW (+ EXPORT) |
| GET | `/reports/workload` | AMC_SCHEDULE VIEW |

**Contracts**
| Method | Path | Access |
|---|---|---|
| GET | `/contracts`, `/contracts/systems`, `/contracts/kpis`, `/contracts/status-summary`, `/contracts/filter-options`, `/contracts/:id`, `/contracts/:id/masters`, `/contracts/:id/renewals`, `/contracts/:id/history`, `/contracts/:id/schedule/preview` | AMC_CONTRACTS VIEW |
| GET | `/contracts/export` | VIEW + EXPORT |
| GET | `/contracts/client-options` | AMC_CONTRACTS CREATE/EDIT or AMC_RENEWAL CREATE |
| GET | `/contracts/:id/schedule/generations` | AMC_SCHEDULE VIEW |
| POST | `/contracts` | CREATE (with contract document) |
| PATCH | `/contracts/:id` | EDIT |
| GET | `/contracts/:id/usage` | AMC_CONTRACTS DELETE + SA — what a Recycle Bin move keeps, and whether a renewal blocks it |
| POST | `/contracts/:id/status` | EDIT (Cancelled also DELETE) |
| POST | `/contracts/:id/schedule/generate` | EDIT — adds missing visits only |
| GET / POST | `/contracts/:id/schedule/regenerate` | EDIT — preview / apply with `reason` (3–300) |
| PUT | `/contracts/:id/masters` | EDIT |
| POST | `/contracts/:id/renewals` | AMC_RENEWAL CREATE (active `salesEngineerId` required) |
| DELETE | `/contracts/:id` | DELETE + SA — to Recycle Bin |

**Visits**
| Method | Path | Access |
|---|---|---|
| GET | `/visits`, `/visits/year-summary`, `/visits/:id` | Any([AMC_SCHEDULE, MONTHLY_CALENDAR],VIEW) |
| GET | `/visits/export` | the same + EXPORT |
| GET | `/visits/monthly-consolidated` (+ `/export`) | AMC_SCHEDULE VIEW (+ EXPORT) |
| PATCH | `/visits/:id` | AMC_SCHEDULE EDIT — amount, date, assignee, notes |
| PATCH | `/visits/:id/color` | AMC_SCHEDULE EDIT |
| PATCH | `/visits/:id/manual-invoice` | INVOICES EDIT — `invoiceNo` (null/empty clears), `expectedUpdatedAt`; entry only on COMPLETED (409 otherwise) |

**Execution / Service Status / Master status**
| Method | Path | Access |
|---|---|---|
| GET | `/execution/visits`, `/execution/visits/:id` | AMC_EXECUTION VIEW |
| PATCH | `/execution/visits/:id` | AMC_EXECUTION EDIT — status change; completion needs a current service report (409 `SERVICE_REPORT_REQUIRED`); completed visits locked (409 `COMPLETION_LOCKED`) |
| GET | `/service-status`, `/service-status/:id`, `/service-status/:id/report/download` | SERVICE_STATUS VIEW |
| GET | `/service-status/options` | Any([SERVICE_STATUS, MONTHLY_CALENDAR, AMC_SCHEDULE],VIEW) |
| GET | `/calendar/options` | Any([MONTHLY_CALENDAR, AMC_SCHEDULE],VIEW) |
| GET | `/service-status/export` | SERVICE_STATUS VIEW + EXPORT |
| PATCH | `/service-status/:id` | AMC_EXECUTION EDIT |
| POST / DELETE | `/service-status/:id/report` | AMC_EXECUTION EDIT — raw body, `X-File-Name` (URI-encoded) |
| GET | `/master-status`, `/master-status/options` (+ `/export`) | MASTER_AMC_STATUS VIEW (+ EXPORT). Items carry `invoiceNumbers` and `invoiceReferences` (same order); the export adds Zoho Invoices (Tracking) and Zoho References (Tracking), hidden with Invoice No. |

### Finance
| Method | Path | Access |
|---|---|---|
| GET | `/api/invoices` | INVOICES VIEW, or READ when scoped to one contract/visit |
| GET | `/api/invoices/summary`, `/billable`, `/:id` | VIEW |
| GET | `/api/invoices/export`, `/billable/export` | VIEW + EXPORT |
| POST | `/api/invoices` | CREATE |
| PATCH / POST | `/api/invoices/:id`, `/api/invoices/:id/cancel` | EDIT |
| GET | `/api/accounts`, `/api/accounts/options` (+ `/export`) | ACCOUNTS VIEW (+ EXPORT) |
| GET | `/api/invoice-acknowledgements`, `/options`, `/:visitId`, `/:visitId/history`, `/:visitId/document` | INVOICE_ACKNOWLEDGEMENTS VIEW — list filters `search`, `clientId`, `contractId`, `invoiceNo`, `status` (PENDING / ACKNOWLEDGED), `dateBasis` (INVOICE_DATE / ACKNOWLEDGED_DATE), `fromDate`, `toDate`, `sort`, `dir`, `page`, `pageSize`. Amounts (`serviceValue`, `invoiceValue`, totals) are null unless the user also holds ACCOUNTS VIEW. `/document` streams the current document (`Cache-Control: no-store`, attachment) |
| GET | `/api/invoice-acknowledgements/export?format=xlsx\|pdf&hidden=…` | INVOICE_ACKNOWLEDGEMENTS VIEW + EXPORT (amount columns only with ACCOUNTS VIEW) |
| POST / DELETE | `/api/invoice-acknowledgements/:visitId/document` | INVOICE_ACKNOWLEDGEMENTS CREATE — attach (raw body, `X-File-Name`; PDF/PNG/JPEG recognised by content, ≤ `ATTACHMENT_MAX_MB`) or remove an attached document before confirmation; status stays PENDING |
| POST | `/api/invoice-acknowledgements/:visitId/confirm` `{ attachmentId }` | INVOICE_ACKNOWLEDGEMENTS CREATE — PENDING → ACKNOWLEDGED; only the named current document, after its file is read back and matches its checksum; 409 when changed or already acknowledged |
| POST | `/api/invoice-acknowledgements/:visitId/replace` | INVOICE_ACKNOWLEDGEMENTS VIEW + EDIT — new version of an ACKNOWLEDGED invoice's document; raw body, `X-File-Name`, `X-Replace-Reason` (URI-encoded, 3–500 characters) |
| GET | `/api/services-sales`, `/options`, `/:id/report` (+ `/export`) | SERVICES_SALES VIEW (+ EXPORT) |
| PATCH | `/api/services-sales/:id` | SERVICES_SALES EDIT — quotation number on completed services |

### Reports — `/api/reports`
`GET /`, `/options`, `/:type` — REPORTS VIEW **and** VIEW of the report's source module (AMC_CONTRACTS, AMC_RENEWAL or ACCOUNTS; P2). `GET /:type/export` — + REPORTS EXPORT **and** the source module's EXPORT. `GET /` lists only the reports the user may open, each with `canExport`; a refused report answers 403 with no figures. Types: AMC Contract Summary, `scheduled-services` (Billing Schedule), Completed Services, Pending Services, Monthly Maintenance, AMC Renewal, Expiry & Renewal Due, Renewal History, Accounts summary, Client-wise, Sales Engineer-wise, Contract Value Review (ids listed by `GET /`).

### Master data — `/api/masters`
| Method | Path | Access |
|---|---|---|
| GET | `/summary` | Signed in (only readable categories) |
| GET | `/<list>`, `/<list>/options`, `/<list>/:id`, `/<list>/:id/history` | read access of the list (list = departments, sales-engineers, system-types, maintenance-frequencies) |
| POST | `/<list>` | module CREATE |
| PATCH / POST | `/<list>/:id`, `/<list>/:id/status` | module EDIT |
| GET | `/sales-engineers/export`, `/system-types/export`, `/departments/export`, `/maintenance-frequencies/export` | VIEW + EXPORT |
| GET | `/sales-engineers/user-options` | SALES_ENGINEERS CREATE or EDIT |
| GET | `/sales-engineers/:id/summary`, `/:id/usage`, `/system-types/:id/usage` | read / VIEW |
| GET | `/system-types/:id/contracts`, `/maintenance-frequencies/:id/contracts` | AMC_CONTRACTS VIEW |
| DELETE | `/sales-engineers/:id`, `/system-types/:id` | SA (system types also SYSTEM_TYPES DELETE) — to Recycle Bin |
| DELETE | `/maintenance-frequencies/:id` | Always 405 |

### Other
| Router | Endpoints | Access |
|---|---|---|
| `/api/attachments` | `GET /limits`, `GET /`, `GET /versions`, `POST /`, `GET /:id/versions`, `POST /:id/versions`, `GET /:id/download` | Checked in the service against the owning record's module (AMC_CONTRACTS, PROCUREMENT, EXPENSES). Service reports are refused here |
| `/api/notifications` | `GET /`, `POST /read-all`, `POST /:key/read` | Signed in; alerts filtered by permissions |
| `/api/suggestions` | `POST /` (SUGGESTIONS CREATE), `GET /mine` (VIEW), `GET /review`, `/review/options` (SUGGESTIONS_REVIEW VIEW), `GET /:id`, `POST /:id/comments` (either module VIEW, ownership checked), `POST /:id/reopen` (CREATE), `PATCH /:id/status`, `/:id/assignment` (REVIEW EDIT) | |
| `/api/holidays` | `GET /` (SETTINGS VIEW), `POST` (CREATE), `PUT /:id` (EDIT), `DELETE /:id` (DELETE) | |
| `/api/historical-data` | `GET /summary`, `/rows`, `/rows/:id` (HISTORICAL_DATA VIEW), `GET /audit` (+ Admin) | Retired module; no page |
| `/api/projects`, `/api/procurement`, `/api/expenses` | List/detail/create/edit/status (expenses: void) | Retired modules (no pages); kept because Invoice Tracking, Settings (VAT default) and existing data depend on them |

## 3. Keeping this document current

Every `authorize(…)` and permission check is cross-checked against the permission catalog by `stslv-api/tests/permission-catalog.test.ts`. When a route is added or changed, update this file and `docs/technical/ROLE_PERMISSION_MATRIX.md` in the same change.
