-- 0094_visit_color_override
-- PREPARED FOR REVIEW. Not applied to stslv_amc_dev or Neon; tested on isolated
-- databases only. A release of this branch applies it when the API starts.
--
-- The manual colour of one scheduled service: level 1 of the Color Priority
-- (Manual > Cancelled > Invoice Pending > First Service > Normal). The other
-- four levels are derived on read and never stored.
--
--   * Nullable: no existing visit changes, and nothing is backfilled.
--   * The palette is a display choice; the reference names the override but not its colours.
--
-- Reverse (only with approval, and it loses manual colours):
--   ALTER TABLE amc_visits DROP CONSTRAINT amc_visits_color_override_ck, DROP COLUMN color_override;

ALTER TABLE amc_visits
  ADD COLUMN color_override text,
  ADD CONSTRAINT amc_visits_color_override_ck CHECK (color_override IN ('RED', 'AMBER', 'GREEN', 'BLUE', 'PURPLE', 'GREY'));
