ALTER TABLE `team_api_keys` ADD `is_invalid` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `team_api_keys` ADD `invalid_reason` text;--> statement-breakpoint
ALTER TABLE `team_api_keys` ADD `last_validated_at` integer;