-- 0113_seed_invoice_acknowledgement_permissions
-- PREPARED FOR REVIEW (STS-ELV, Invoice Acknowledgements 2026-11-10). Apply together with 0112.
--
-- The new permission module INVOICE_ACKNOWLEDGEMENTS (0112). Super Admin (role code ADMIN) holds every action of every
-- module, as 0092 did for the modules it added. NO other role is given anything: Admin, Finance Executive and the
-- other roles start without the page until Super Admin grants it in Roles & Permissions (proposed grants are in
-- docs/INVOICE_ACKNOWLEDGEMENTS.md, for approval). Additive and idempotent; changes no other grant.
--
-- Reverse (only with approval):
--   DELETE FROM role_permissions WHERE module = 'INVOICE_ACKNOWLEDGEMENTS';

INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, 'INVOICE_ACKNOWLEDGEMENTS', a.action
FROM roles r
CROSS JOIN (VALUES ('VIEW'), ('CREATE'), ('EDIT'), ('DELETE'), ('APPROVE'), ('EXPORT'), ('READ')) AS a (action)
WHERE r.code = 'ADMIN'
ON CONFLICT DO NOTHING;
