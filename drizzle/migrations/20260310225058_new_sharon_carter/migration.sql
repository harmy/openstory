CREATE TABLE `credit_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`original_amount` integer NOT NULL,
	`remaining_amount` integer NOT NULL,
	`source` text NOT NULL,
	`transaction_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_credit_batches_team_id` ON `credit_batches` (`team_id`);--> statement-breakpoint
CREATE INDEX `idx_credit_batches_team_remaining_created` ON `credit_batches` (`team_id`,`remaining_amount`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_credit_batches_expires_at` ON `credit_batches` (`expires_at`);--> statement-breakpoint
DROP TABLE `character_sheets`;--> statement-breakpoint
DROP TABLE `frame_characters`;--> statement-breakpoint
DROP TABLE `frame_locations`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_gift_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`amount_micros` integer NOT NULL,
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
INSERT INTO `__new_gift_tokens`("id", "code", "amount_micros", "created_by_user_id", "redeemed_by_team_id", "redeemed_by_user_id", "redeemed_at", "expires_at", "note", "created_at") SELECT "id", "code", CAST(ROUND("amount_usd" * 1000000) AS INTEGER), "created_by_user_id", "redeemed_by_team_id", "redeemed_by_user_id", "redeemed_at", "expires_at", "note", "created_at" FROM `gift_tokens`;--> statement-breakpoint
DROP TABLE `gift_tokens`;--> statement-breakpoint
ALTER TABLE `__new_gift_tokens` RENAME TO `gift_tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `gift_tokens_code_unique` ON `gift_tokens` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_gift_tokens_code` ON `gift_tokens` (`code`);--> statement-breakpoint
CREATE INDEX `idx_gift_tokens_created_by` ON `gift_tokens` (`created_by_user_id`);--> statement-breakpoint
CREATE TABLE `__new_team_billing_settings` (
	`team_id` text PRIMARY KEY NOT NULL,
	`stripe_customer_id` text,
	`auto_top_up_enabled` integer DEFAULT true NOT NULL,
	`auto_top_up_threshold_micros` integer DEFAULT 5000000,
	`auto_top_up_amount_micros` integer DEFAULT 100000000,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_team_billing_settings`("team_id", "stripe_customer_id", "auto_top_up_enabled", "auto_top_up_threshold_micros", "auto_top_up_amount_micros", "updated_at") SELECT "team_id", "stripe_customer_id", "auto_top_up_enabled", CAST(ROUND("auto_top_up_threshold_usd" * 1000000) AS INTEGER), CAST(ROUND("auto_top_up_amount_usd" * 1000000) AS INTEGER), "updated_at" FROM `team_billing_settings`;--> statement-breakpoint
DROP TABLE `team_billing_settings`;--> statement-breakpoint
ALTER TABLE `__new_team_billing_settings` RENAME TO `team_billing_settings`;--> statement-breakpoint
CREATE TABLE `__new_credits` (
	`team_id` text PRIMARY KEY NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "positive_balance" CHECK("__new_credits"."balance" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_credits`("team_id", "balance", "updated_at") SELECT "team_id", CAST(ROUND("balance" * 1000000) AS INTEGER), "updated_at" FROM `credits`;--> statement-breakpoint
DROP TABLE `credits`;--> statement-breakpoint
ALTER TABLE `__new_credits` RENAME TO `credits`;--> statement-breakpoint
CREATE TABLE `__new_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text,
	`type` text NOT NULL,
	`amount` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`metadata` text,
	`stripe_session_id` text,
	`description` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_transactions`("id", "team_id", "user_id", "type", "amount", "balance_after", "metadata", "stripe_session_id", "description", "created_at") SELECT "id", "team_id", "user_id", "type", CAST(ROUND("amount" * 1000000) AS INTEGER), CAST(ROUND("balance_after" * 1000000) AS INTEGER), "metadata", "stripe_session_id", "description", "created_at" FROM `transactions`;--> statement-breakpoint
DROP TABLE `transactions`;--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;--> statement-breakpoint
CREATE INDEX `idx_transactions_created_at` ON `transactions` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_transactions_type` ON `transactions` (`type`);--> statement-breakpoint
CREATE INDEX `idx_transactions_team_id` ON `transactions` (`team_id`);--> statement-breakpoint
CREATE INDEX `idx_transactions_user_id` ON `transactions` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_transactions_stripe_session_id` ON `transactions` (`stripe_session_id`);

--> statement-breakpoint
INSERT INTO `credit_batches` ("id", "team_id", "original_amount", "remaining_amount", "source", "expires_at", "created_at") SELECT lower(hex(randomblob(16))), "team_id", "balance", "balance", 'migration', unixepoch('now', '+12 months'), unixepoch('now') FROM `credits` WHERE "balance" > 0;