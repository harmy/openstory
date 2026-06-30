-- #991 SSF Phase 4 (folds in #713 server-side prompt resolution).
--
-- 1-2. Additive columns: the motion `shot_prompt_versions` row becomes the full
-- immutable MotionPrompt snapshot — `text` (fullPrompt) + `components` +
-- `parameters` already existed; `dialogue` + `audio` carry the structured
-- direction audio-capable video models append at render time. (ADD COLUMN — no
-- table rebuild, so no FK-cascade trap; CLAUDE.md / #612.)
ALTER TABLE `shot_prompt_versions` ADD `dialogue` text;--> statement-breakpoint
ALTER TABLE `shot_prompt_versions` ADD `audio` text;--> statement-breakpoint

-- 3. Backfill the motion selection pointer (mirrors #989 step 6 for frames).
-- `shots.selected_motion_prompt_version_id` was NEVER populated before this PR,
-- so resolution + the Phase-3 render manifest were ignoring the version table on
-- every pre-existing shot. Point each shot at its latest motion version so
-- #713's pointer-driven resolution takes effect on existing data. Pure UPDATE,
-- guarded `IS NULL` + `EXISTS` so it is safe to re-run.
UPDATE `shots`
SET `selected_motion_prompt_version_id` = (
	SELECT spv.`id` FROM `shot_prompt_versions` spv
	WHERE spv.`shot_id` = `shots`.`id` AND spv.`prompt_type` = 'motion'
	ORDER BY spv.`created_at` DESC, spv.`id` DESC
	LIMIT 1
)
WHERE `selected_motion_prompt_version_id` IS NULL
	AND EXISTS (
		SELECT 1 FROM `shot_prompt_versions` spv
		WHERE spv.`shot_id` = `shots`.`id` AND spv.`prompt_type` = 'motion'
	);--> statement-breakpoint

-- 4. Hydrate `dialogue` + `audio` on the now-selected motion version from the
-- shot's legacy `metadata.prompts.motion` (frame.metadata IS the Scene; the old
-- workflow wrote the structured prompt there). Restricted to the selected row
-- (what resolution reads) and only where both are still null, so it never
-- clobbers rows written by the new code path. `json_valid` guards malformed
-- metadata; `json_extract` of the nested object returns well-formed JSON text
-- that round-trips through the `text({mode:'json'})` column.
UPDATE `shot_prompt_versions`
SET
	`dialogue` = (
		SELECT json_extract(s.`metadata`, '$.prompts.motion.dialogue')
		FROM `shots` s
		WHERE s.`selected_motion_prompt_version_id` = `shot_prompt_versions`.`id`
			AND json_valid(s.`metadata`)
	),
	`audio` = (
		SELECT json_extract(s.`metadata`, '$.prompts.motion.audio')
		FROM `shots` s
		WHERE s.`selected_motion_prompt_version_id` = `shot_prompt_versions`.`id`
			AND json_valid(s.`metadata`)
	)
WHERE `prompt_type` = 'motion'
	AND `dialogue` IS NULL
	AND `audio` IS NULL
	AND EXISTS (
		SELECT 1 FROM `shots` s
		WHERE s.`selected_motion_prompt_version_id` = `shot_prompt_versions`.`id`
			AND json_valid(s.`metadata`)
			AND json_extract(s.`metadata`, '$.prompts.motion') IS NOT NULL
	);
