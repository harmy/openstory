CREATE TABLE `sequence_exports` (
	`id` text PRIMARY KEY,
	`sequence_id` text NOT NULL,
	`url` text NOT NULL,
	`storage_path` text NOT NULL,
	`duration_seconds` integer,
	`source_frames_hash` text,
	`source_music_variant_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_sequence_exports_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE `sequence_music_variants` ADD `loudness_gain_db` real;--> statement-breakpoint
CREATE INDEX `idx_sequence_exports_sequence` ON `sequence_exports` (`sequence_id`);--> statement-breakpoint
CREATE INDEX `idx_sequence_exports_created_at` ON `sequence_exports` (`created_at`);