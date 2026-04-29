CREATE TABLE `gift_token_redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`gift_token_id` text NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text,
	`redeemed_at` integer NOT NULL,
	FOREIGN KEY (`gift_token_id`) REFERENCES `gift_tokens`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_gift_token_redemptions_token_team` ON `gift_token_redemptions` (`gift_token_id`,`team_id`);--> statement-breakpoint
CREATE INDEX `idx_gift_token_redemptions_token` ON `gift_token_redemptions` (`gift_token_id`);--> statement-breakpoint
CREATE INDEX `idx_gift_token_redemptions_team` ON `gift_token_redemptions` (`team_id`);--> statement-breakpoint
INSERT INTO `gift_token_redemptions` (`id`, `gift_token_id`, `team_id`, `user_id`, `redeemed_at`)
  SELECT lower(hex(randomblob(16))), `id`, `redeemed_by_team_id`, `redeemed_by_user_id`, `redeemed_at`
  FROM `gift_tokens`
  WHERE `redeemed_at` IS NOT NULL AND `redeemed_by_team_id` IS NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_gift_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`amount_micros` integer NOT NULL,
	`max_redemptions` integer DEFAULT 1 NOT NULL,
	`created_by_user_id` text NOT NULL,
	`expires_at` integer,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_gift_tokens`("id", "code", "amount_micros", "max_redemptions", "created_by_user_id", "expires_at", "note", "created_at") SELECT "id", "code", "amount_micros", 1, "created_by_user_id", "expires_at", "note", "created_at" FROM `gift_tokens`;--> statement-breakpoint
DROP TABLE `gift_tokens`;--> statement-breakpoint
ALTER TABLE `__new_gift_tokens` RENAME TO `gift_tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `gift_tokens_code_unique` ON `gift_tokens` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_gift_tokens_code` ON `gift_tokens` (`code`);--> statement-breakpoint
CREATE INDEX `idx_gift_tokens_created_by` ON `gift_tokens` (`created_by_user_id`);