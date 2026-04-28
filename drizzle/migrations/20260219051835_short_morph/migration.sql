CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `audio` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`file_url` text NOT NULL,
	`duration_ms` integer,
	`metadata` text DEFAULT '{}',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_audio_name` ON `audio` (`name`);--> statement-breakpoint
CREATE INDEX `idx_audio_team_id` ON `audio` (`team_id`);--> statement-breakpoint
CREATE TABLE `character_sheets` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`image_url` text,
	`image_path` text,
	`is_default` integer DEFAULT false,
	`source` text DEFAULT 'manual_upload' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_character_sheets_character_id` ON `character_sheets` (`character_id`);--> statement-breakpoint
CREATE INDEX `idx_character_sheets_is_default` ON `character_sheets` (`is_default`);--> statement-breakpoint
CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence_id` text NOT NULL,
	`talent_id` text,
	`character_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`age` text NOT NULL,
	`gender` text,
	`ethnicity` text,
	`physical_description` text,
	`standard_clothing` text,
	`distinguishing_features` text,
	`consistency_tag` text,
	`first_mention_scene_id` text,
	`first_mention_text` text,
	`first_mention_line` integer,
	`sheet_image_url` text,
	`sheet_image_path` text,
	`sheet_status` text DEFAULT 'pending' NOT NULL,
	`sheet_generated_at` integer,
	`sheet_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`talent_id`) REFERENCES `talent`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_characters_sequence_id` ON `characters` (`sequence_id`);--> statement-breakpoint
CREATE INDEX `idx_characters_talent_id` ON `characters` (`talent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `characters_sequence_character_key` ON `characters` (`sequence_id`,`character_id`);--> statement-breakpoint
CREATE TABLE `credits` (
	`team_id` text PRIMARY KEY NOT NULL,
	`balance` real DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "positive_balance" CHECK("credits"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE `frame_characters` (
	`id` text PRIMARY KEY NOT NULL,
	`frame_id` text NOT NULL,
	`character_id` text NOT NULL,
	`character_sheet_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`frame_id`) REFERENCES `frames`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_sheet_id`) REFERENCES `character_sheets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_frame_characters_frame_id` ON `frame_characters` (`frame_id`);--> statement-breakpoint
CREATE INDEX `idx_frame_characters_character_id` ON `frame_characters` (`character_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `frame_characters_frame_character_key` ON `frame_characters` (`frame_id`,`character_id`);--> statement-breakpoint
CREATE TABLE `frame_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`frame_id` text NOT NULL,
	`location_id` text NOT NULL,
	`location_sheet_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`frame_id`) REFERENCES `frames`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `sequence_locations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_sheet_id`) REFERENCES `location_sheets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_frame_locations_frame_id` ON `frame_locations` (`frame_id`);--> statement-breakpoint
CREATE INDEX `idx_frame_locations_location_id` ON `frame_locations` (`location_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `frame_locations_frame_location_key` ON `frame_locations` (`frame_id`,`location_id`);--> statement-breakpoint
CREATE TABLE `frames` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence_id` text NOT NULL,
	`order_index` integer NOT NULL,
	`description` text,
	`duration_ms` integer DEFAULT 3000,
	`thumbnail_url` text,
	`thumbnail_path` text,
	`variant_image_url` text,
	`variant_image_status` text DEFAULT 'pending',
	`video_url` text,
	`video_path` text,
	`thumbnail_status` text DEFAULT 'pending',
	`thumbnail_workflow_run_id` text,
	`thumbnail_generated_at` integer,
	`thumbnail_error` text,
	`image_model` text(100) DEFAULT 'nano_banana_pro' NOT NULL,
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
CREATE INDEX `idx_frames_order` ON `frames` (`sequence_id`,`order_index`);--> statement-breakpoint
CREATE INDEX `idx_frames_sequence_id` ON `frames` (`sequence_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `frames_sequence_id_order_index_key` ON `frames` (`sequence_id`,`order_index`);--> statement-breakpoint
CREATE TABLE `location_library` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`description` text,
	`reference_image_url` text,
	`reference_image_path` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_location_library_team_id` ON `location_library` (`team_id`);--> statement-breakpoint
CREATE INDEX `idx_location_library_name` ON `location_library` (`name`);--> statement-breakpoint
CREATE TABLE `location_sheets` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`description` text,
	`image_url` text,
	`image_path` text,
	`is_default` integer DEFAULT false,
	`source` text DEFAULT 'manual_upload' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `location_library`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_location_sheets_location_id` ON `location_sheets` (`location_id`);--> statement-breakpoint
CREATE INDEX `idx_location_sheets_is_default` ON `location_sheets` (`is_default`);--> statement-breakpoint
CREATE TABLE `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`transports` text,
	`created_at` integer,
	`aaguid` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkey_userId_idx` ON `passkey` (`user_id`);--> statement-breakpoint
CREATE INDEX `passkey_credentialID_idx` ON `passkey` (`credential_id`);--> statement-breakpoint
CREATE TABLE `sequence_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence_id` text NOT NULL,
	`library_location_id` text,
	`location_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`type` text,
	`time_of_day` text,
	`description` text,
	`architectural_style` text,
	`key_features` text,
	`color_palette` text,
	`lighting_setup` text,
	`ambiance` text,
	`consistency_tag` text,
	`first_mention_scene_id` text,
	`first_mention_text` text,
	`first_mention_line` integer,
	`reference_image_url` text,
	`reference_image_path` text,
	`reference_status` text DEFAULT 'pending' NOT NULL,
	`reference_generated_at` integer,
	`reference_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`library_location_id`) REFERENCES `location_library`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_sequence_locations_sequence_id` ON `sequence_locations` (`sequence_id`);--> statement-breakpoint
CREATE INDEX `idx_sequence_locations_library_location_id` ON `sequence_locations` (`library_location_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_locations_sequence_location_key` ON `sequence_locations` (`sequence_id`,`location_id`);--> statement-breakpoint
CREATE TABLE `sequences` (
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
	`image_model` text(100) DEFAULT 'nano_banana_pro' NOT NULL,
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
CREATE INDEX `idx_sequences_created_at` ON `sequences` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_sequences_status` ON `sequences` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sequences_style_id` ON `sequences` (`style_id`);--> statement-breakpoint
CREATE INDEX `idx_sequences_team_id` ON `sequences` (`team_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `styles` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`description` text,
	`config` text NOT NULL,
	`category` text(100),
	`tags` text,
	`is_public` integer DEFAULT false,
	`is_template` integer DEFAULT false,
	`version` integer DEFAULT 1,
	`preview_url` text,
	`usage_count` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_styles_team_id` ON `styles` (`team_id`);--> statement-breakpoint
CREATE TABLE `talent` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`description` text,
	`image_url` text,
	`image_path` text,
	`is_favorite` integer DEFAULT false,
	`is_human` integer DEFAULT false,
	`is_in_team_library` integer DEFAULT false,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_talent_team_id` ON `talent` (`team_id`);--> statement-breakpoint
CREATE INDEX `idx_talent_name` ON `talent` (`name`);--> statement-breakpoint
CREATE INDEX `idx_talent_is_favorite` ON `talent` (`is_favorite`);--> statement-breakpoint
CREATE INDEX `idx_talent_is_in_team_library` ON `talent` (`is_in_team_library`);--> statement-breakpoint
CREATE TABLE `talent_media` (
	`id` text PRIMARY KEY NOT NULL,
	`talent_id` text NOT NULL,
	`type` text NOT NULL,
	`url` text NOT NULL,
	`path` text,
	`metadata` text DEFAULT '{}',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`talent_id`) REFERENCES `talent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_talent_media_talent_id` ON `talent_media` (`talent_id`);--> statement-breakpoint
CREATE INDEX `idx_talent_media_type` ON `talent_media` (`type`);--> statement-breakpoint
CREATE TABLE `talent_sheets` (
	`id` text PRIMARY KEY NOT NULL,
	`talent_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`image_url` text,
	`image_path` text,
	`metadata` text,
	`is_default` integer DEFAULT false,
	`source` text DEFAULT 'manual_upload' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`talent_id`) REFERENCES `talent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_talent_sheets_talent_id` ON `talent_sheets` (`talent_id`);--> statement-breakpoint
CREATE INDEX `idx_talent_sheets_is_default` ON `talent_sheets` (`is_default`);--> statement-breakpoint
CREATE TABLE `team_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`provider` text NOT NULL,
	`encrypted_key` text NOT NULL,
	`key_iv` text NOT NULL,
	`key_tag` text NOT NULL,
	`key_hint` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`added_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_team_api_keys_team_provider` ON `team_api_keys` (`team_id`,`provider`);--> statement-breakpoint
CREATE INDEX `idx_team_api_keys_team_id` ON `team_api_keys` (`team_id`);--> statement-breakpoint
CREATE TABLE `team_billing_settings` (
	`team_id` text PRIMARY KEY NOT NULL,
	`stripe_customer_id` text,
	`auto_top_up_enabled` integer DEFAULT true NOT NULL,
	`auto_top_up_threshold_usd` real DEFAULT 5,
	`auto_top_up_amount_usd` real DEFAULT 25,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `team_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`email` text(255) NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`invited_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`token` text(255) NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`accepted_at` integer,
	`declined_at` integer,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_team_invitations_email` ON `team_invitations` (`email`);--> statement-breakpoint
CREATE INDEX `idx_team_invitations_expires_at` ON `team_invitations` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_team_invitations_status` ON `team_invitations` (`status`);--> statement-breakpoint
CREATE INDEX `idx_team_invitations_team_id` ON `team_invitations` (`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_team_invitations_token` ON `team_invitations` (`token`);--> statement-breakpoint
CREATE INDEX `idx_team_invitations_unique_pending` ON `team_invitations` (`team_id`,`email`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_team_members_team_id` ON `team_members` (`team_id`);--> statement-breakpoint
CREATE INDEX `idx_team_members_user_id` ON `team_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text(255) NOT NULL,
	`slug` text(255) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_teams_slug` ON `teams` (`slug`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text,
	`type` text NOT NULL,
	`amount` real NOT NULL,
	`balance_after` real NOT NULL,
	`metadata` text,
	`description` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_transactions_created_at` ON `transactions` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_transactions_type` ON `transactions` (`type`);--> statement-breakpoint
CREATE INDEX `idx_transactions_team_id` ON `transactions` (`team_id`);--> statement-breakpoint
CREATE INDEX `idx_transactions_user_id` ON `transactions` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`access_code` text,
	`status` text DEFAULT 'pending'
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `vfx` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`preset_config` text DEFAULT '{}' NOT NULL,
	`preview_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_vfx_name` ON `vfx` (`name`);--> statement-breakpoint
CREATE INDEX `idx_vfx_team_id` ON `vfx` (`team_id`);