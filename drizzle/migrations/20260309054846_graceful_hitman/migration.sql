CREATE TABLE `gift_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`amount_usd` real NOT NULL,
	`created_by_user_id` text NOT NULL,
	`redeemed_by_team_id` text,
	`redeemed_by_user_id` text,
	`redeemed_at` integer,
	`expires_at` integer,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`redeemed_by_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`redeemed_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gift_tokens_code_unique` ON `gift_tokens` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_gift_tokens_code` ON `gift_tokens` (`code`);--> statement-breakpoint
CREATE INDEX `idx_gift_tokens_created_by` ON `gift_tokens` (`created_by_user_id`);