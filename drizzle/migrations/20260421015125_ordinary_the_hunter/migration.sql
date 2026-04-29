CREATE TABLE `sequence_elements` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence_id` text NOT NULL,
	`uploaded_filename` text(500) NOT NULL,
	`token` text(100) NOT NULL,
	`description` text,
	`consistency_tag` text,
	`image_url` text NOT NULL,
	`image_path` text NOT NULL,
	`vision_status` text DEFAULT 'pending' NOT NULL,
	`vision_error` text,
	`vision_generated_at` integer,
	`first_mention_scene_id` text,
	`first_mention_text` text,
	`first_mention_line` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_sequence_elements_sequence_id` ON `sequence_elements` (`sequence_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_elements_sequence_token_key` ON `sequence_elements` (`sequence_id`,`token`);