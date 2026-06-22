ALTER TABLE `sequence_exports` ADD `status` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `sequence_exports` ADD `error` text;--> statement-breakpoint
ALTER TABLE `sequence_exports` ADD `workflow_run_id` text;
