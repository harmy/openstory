CREATE TABLE `frame_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`frame_id` text NOT NULL,
	`sequence_id` text NOT NULL,
	`variant_type` text NOT NULL,
	`model` text(100) NOT NULL,
	`url` text,
	`storage_path` text,
	`preview_url` text,
	`shot_variant_url` text,
	`shot_variant_path` text,
	`shot_variant_status` text DEFAULT 'pending',
	`shot_variant_workflow_run_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`workflow_run_id` text,
	`generated_at` integer,
	`error` text,
	`prompt_hash` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`frame_id`) REFERENCES `frames`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_frame_variants_frame_type` ON `frame_variants` (`frame_id`,`variant_type`);--> statement-breakpoint
CREATE INDEX `idx_frame_variants_sequence_type` ON `frame_variants` (`sequence_id`,`variant_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `frame_variants_frame_type_model_key` ON `frame_variants` (`frame_id`,`variant_type`,`model`);--> statement-breakpoint
INSERT INTO `frame_variants` (`id`, `frame_id`, `sequence_id`, `variant_type`, `model`, `url`, `storage_path`, `preview_url`, `shot_variant_url`, `shot_variant_status`, `shot_variant_workflow_run_id`, `status`, `workflow_run_id`, `generated_at`, `error`, `prompt_hash`, `duration_ms`, `created_at`, `updated_at`)
SELECT
  lower(hex(randomblob(13))),
  `id`,
  `sequence_id`,
  'image',
  COALESCE(`image_model`, 'flux_2_dev'),
  `thumbnail_url`,
  `thumbnail_path`,
  `preview_thumbnail_url`,
  `variant_image_url`,
  COALESCE(`variant_image_status`, 'pending'),
  `variant_workflow_run_id`,
  COALESCE(`thumbnail_status`, 'pending'),
  `thumbnail_workflow_run_id`,
  `thumbnail_generated_at`,
  `thumbnail_error`,
  NULL,
  NULL,
  COALESCE(`created_at`, unixepoch()),
  unixepoch()
FROM `frames`
WHERE `thumbnail_url` IS NOT NULL OR `thumbnail_status` != 'pending';
