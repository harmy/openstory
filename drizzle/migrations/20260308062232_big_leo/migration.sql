PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_frames` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence_id` text NOT NULL,
	`order_index` integer NOT NULL,
	`description` text,
	`duration_ms` integer DEFAULT 3000,
	`thumbnail_url` text,
	`thumbnail_path` text,
	`variant_image_url` text,
	`variant_image_status` text DEFAULT 'pending',
	`variant_workflow_run_id` text,
	`video_url` text,
	`video_path` text,
	`thumbnail_status` text DEFAULT 'pending',
	`thumbnail_workflow_run_id` text,
	`thumbnail_generated_at` integer,
	`thumbnail_error` text,
	`image_model` text(100) DEFAULT 'nano_banana_2' NOT NULL,
	`image_prompt` text,
	`video_status` text DEFAULT 'pending',
	`video_workflow_run_id` text,
	`video_generated_at` integer,
	`video_error` text,
	`motion_prompt` text,
	`motion_model` text(100),
	`audio_url` text,
	`audio_path` text,
	`audio_status` text DEFAULT 'pending',
	`audio_workflow_run_id` text,
	`audio_generated_at` integer,
	`audio_error` text,
	`audio_model` text(100),
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_frames`("id", "sequence_id", "order_index", "description", "duration_ms", "thumbnail_url", "thumbnail_path", "variant_image_url", "variant_image_status", "variant_workflow_run_id", "video_url", "video_path", "thumbnail_status", "thumbnail_workflow_run_id", "thumbnail_generated_at", "thumbnail_error", "image_model", "image_prompt", "video_status", "video_workflow_run_id", "video_generated_at", "video_error", "motion_prompt", "motion_model", "audio_url", "audio_path", "audio_status", "audio_workflow_run_id", "audio_generated_at", "audio_error", "audio_model", "metadata", "created_at", "updated_at") SELECT "id", "sequence_id", "order_index", "description", "duration_ms", "thumbnail_url", "thumbnail_path", "variant_image_url", "variant_image_status", "variant_workflow_run_id", "video_url", "video_path", "thumbnail_status", "thumbnail_workflow_run_id", "thumbnail_generated_at", "thumbnail_error", "image_model", "image_prompt", "video_status", "video_workflow_run_id", "video_generated_at", "video_error", "motion_prompt", "motion_model", "audio_url", "audio_path", "audio_status", "audio_workflow_run_id", "audio_generated_at", "audio_error", "audio_model", "metadata", "created_at", "updated_at" FROM `frames`;--> statement-breakpoint
DROP TABLE `frames`;--> statement-breakpoint
ALTER TABLE `__new_frames` RENAME TO `frames`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_frames_order` ON `frames` (`sequence_id`,`order_index`);--> statement-breakpoint
CREATE INDEX `idx_frames_sequence_id` ON `frames` (`sequence_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `frames_sequence_id_order_index_key` ON `frames` (`sequence_id`,`order_index`);--> statement-breakpoint
CREATE TABLE `__new_sequences` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`title` text(500) NOT NULL,
	`script` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`updated_by` text,
	`style_id` text NOT NULL,
	`aspect_ratio` text(10) DEFAULT '16:9' NOT NULL,
	`analysis_model` text(100) DEFAULT 'anthropic/claude-haiku-4.5' NOT NULL,
	`analysis_duration_ms` integer DEFAULT 0 NOT NULL,
	`image_model` text(100) DEFAULT 'nano_banana_2' NOT NULL,
	`video_model` text(100) DEFAULT 'kling_v3_pro' NOT NULL,
	`workflow` text(100),
	`merged_video_url` text,
	`merged_video_path` text,
	`merged_video_status` text DEFAULT 'pending',
	`merged_video_generated_at` integer,
	`merged_video_error` text,
	`music_url` text,
	`music_path` text,
	`music_status` text DEFAULT 'pending',
	`music_generated_at` integer,
	`music_error` text,
	`music_model` text(100),
	`music_prompt` text,
	`music_tags` text,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`style_id`) REFERENCES `styles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_sequences`("id", "team_id", "title", "script", "status", "created_at", "updated_at", "created_by", "updated_by", "style_id", "aspect_ratio", "analysis_model", "analysis_duration_ms", "image_model", "video_model", "workflow", "merged_video_url", "merged_video_path", "merged_video_status", "merged_video_generated_at", "merged_video_error", "music_url", "music_path", "music_status", "music_generated_at", "music_error", "music_model", "music_prompt", "music_tags") SELECT "id", "team_id", "title", "script", "status", "created_at", "updated_at", "created_by", "updated_by", "style_id", "aspect_ratio", "analysis_model", "analysis_duration_ms", "image_model", "video_model", "workflow", "merged_video_url", "merged_video_path", "merged_video_status", "merged_video_generated_at", "merged_video_error", "music_url", "music_path", "music_status", "music_generated_at", "music_error", "music_model", "music_prompt", "music_tags" FROM `sequences`;--> statement-breakpoint
DROP TABLE `sequences`;--> statement-breakpoint
ALTER TABLE `__new_sequences` RENAME TO `sequences`;--> statement-breakpoint
CREATE INDEX `idx_sequences_created_at` ON `sequences` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_sequences_status` ON `sequences` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sequences_style_id` ON `sequences` (`style_id`);--> statement-breakpoint
CREATE INDEX `idx_sequences_team_id` ON `sequences` (`team_id`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `stripe_session_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_transactions_stripe_session_id` ON `transactions` (`stripe_session_id`);