-- Adds the soft-delete `discarded_at` column to the three sheet-variant
-- tables for issue #626 (Stage 2 staleness/divergence UI).
--
-- `frame_variants.discarded_at` was already added in
-- 20260503055203_sticky_xorn but a later snapshot regeneration dropped it
-- from the snapshot, so drizzle re-emits the ALTER for it here. The column
-- already exists in production, and SQLite has no `IF NOT EXISTS` for ADD
-- COLUMN, so the redundant statement is omitted to avoid a duplicate-column
-- error when the migrator runs against an existing schema.
ALTER TABLE `character_sheet_variants` ADD `discarded_at` integer;--> statement-breakpoint
ALTER TABLE `location_sheet_variants` ADD `discarded_at` integer;--> statement-breakpoint
ALTER TABLE `talent_sheet_variants` ADD `discarded_at` integer;
