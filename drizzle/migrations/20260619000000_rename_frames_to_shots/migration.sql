ALTER TABLE `frames` RENAME TO `shots`;
--> statement-breakpoint
ALTER TABLE `frame_variants` RENAME TO `shot_variants`;
--> statement-breakpoint
ALTER TABLE `shot_variants` RENAME COLUMN `frame_id` TO `shot_id`;
--> statement-breakpoint
ALTER TABLE `frame_prompt_variants` RENAME TO `shot_prompt_variants`;
--> statement-breakpoint
ALTER TABLE `shot_prompt_variants` RENAME COLUMN `frame_id` TO `shot_id`;
