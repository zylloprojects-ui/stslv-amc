-- 0115_seed_invoice_acknowledgement_defaults
-- PREPARED FOR REVIEW. Approved default permissions for Invoice Acknowledgements (owner, 2026-11-10):
--   Super Admin        every action (0113 already granted it; unchanged here)
--   Admin              View, Create, Edit, Export
--   Finance Executive  View, Create, Export
--   Viewer and every other role: nothing new.
-- Insert-only and idempotent (ON CONFLICT DO NOTHING): no existing grant of any role is removed or changed, so a
-- role Super Admin has customised keeps everything it holds. Safe to apply more than once.
--
-- Reverse (only with approval):
--   DELETE FROM role_permissions p USING roles r WHERE r.id = p.role_id AND p.module = 'INVOICE_ACKNOWLEDGEMENTS'
--     AND r.code IN ('ADMINISTRATOR', 'FINANCE_EXECUTIVE');

INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, 'INVOICE_ACKNOWLEDGEMENTS', g.action
FROM roles r
JOIN (VALUES
  ('ADMINISTRATOR', 'VIEW'), ('ADMINISTRATOR', 'CREATE'), ('ADMINISTRATOR', 'EDIT'), ('ADMINISTRATOR', 'EXPORT'),
  ('FINANCE_EXECUTIVE', 'VIEW'), ('FINANCE_EXECUTIVE', 'CREATE'), ('FINANCE_EXECUTIVE', 'EXPORT')
) AS g (code, action) ON g.code = r.code
ON CONFLICT DO NOTHING;
