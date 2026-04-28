PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_team_billing_settings` (
	`team_id` text PRIMARY KEY NOT NULL,
	`stripe_customer_id` text,
	`auto_top_up_enabled` integer DEFAULT false NOT NULL,
	`auto_top_up_threshold_micros` integer DEFAULT 5000000,
	`auto_top_up_amount_micros` integer DEFAULT 100000000,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_team_billing_settings`("team_id", "stripe_customer_id", "auto_top_up_enabled", "auto_top_up_threshold_micros", "auto_top_up_amount_micros", "updated_at") SELECT "team_id", "stripe_customer_id", "auto_top_up_enabled", "auto_top_up_threshold_micros", "auto_top_up_amount_micros", "updated_at" FROM `team_billing_settings`;--> statement-breakpoint
DROP TABLE `team_billing_settings`;--> statement-breakpoint
ALTER TABLE `__new_team_billing_settings` RENAME TO `team_billing_settings`;--> statement-breakpoint
UPDATE `team_billing_settings` SET `auto_top_up_enabled` = 0;--> statement-breakpoint
PRAGMA foreign_keys=ON;