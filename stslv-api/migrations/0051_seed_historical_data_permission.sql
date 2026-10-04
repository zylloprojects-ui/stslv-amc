-- 0051_seed_historical_data_permission
-- Grants the HISTORICAL_DATA module (0050) to ADMIN, like every other module.
-- Idempotent: ON CONFLICT DO NOTHING.
--
-- No other role receives it. The review shows every client's names, job
-- values and invoice references from the earlier registers, so who else may
-- see it is for the business to decide: an Admin grants it in Users & Access.

INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, 'HISTORICAL_DATA', a.action
FROM roles r
CROSS JOIN (VALUES
  ('VIEW'), ('CREATE'), ('EDIT'), ('DELETE'), ('APPROVE'), ('EXPORT')
) AS a (action)
WHERE r.code = 'ADMIN'
ON CONFLICT DO NOTHING;
