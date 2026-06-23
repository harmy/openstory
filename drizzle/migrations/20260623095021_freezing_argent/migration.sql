ALTER TABLE `sequence_exports` RENAME COLUMN `source_frames_hash` TO `source_shots_hash`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_frame_prompt_variants_frame_type_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `uq_frame_prompt_variants_frame_type_hash_ai`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_frame_variants_frame_type`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_frame_variants_sequence_type`;--> statement-breakpoint
DROP INDEX IF EXISTS `frame_variants_primary_key`;--> statement-breakpoint
DROP INDEX IF EXISTS `frame_variants_divergent_key`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_frames_order`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_frames_sequence_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `frames_sequence_id_order_index_key`;--> statement-breakpoint
CREATE INDEX `idx_shot_prompt_variants_shot_type_created` ON `shot_prompt_variants` (`shot_id`,`prompt_type`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shot_prompt_variants_shot_type_hash_ai` ON `shot_prompt_variants` (`shot_id`,`prompt_type`,`input_hash`) WHERE "shot_prompt_variants"."input_hash" IS NOT NULL AND "shot_prompt_variants"."source" != 'restored';--> statement-breakpoint
CREATE INDEX `idx_shot_variants_shot_type` ON `shot_variants` (`shot_id`,`variant_type`);--> statement-breakpoint
CREATE INDEX `idx_shot_variants_sequence_type` ON `shot_variants` (`sequence_id`,`variant_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `shot_variants_primary_key` ON `shot_variants` (`shot_id`,`variant_type`,`model`) WHERE "shot_variants"."diverged_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `shot_variants_divergent_key` ON `shot_variants` (`shot_id`,`variant_type`,`model`,`input_hash`) WHERE "shot_variants"."diverged_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_shots_order` ON `shots` (`sequence_id`,`order_index`);--> statement-breakpoint
CREATE INDEX `idx_shots_sequence_id` ON `shots` (`sequence_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `shots_sequence_id_order_index_key` ON `shots` (`sequence_id`,`order_index`);