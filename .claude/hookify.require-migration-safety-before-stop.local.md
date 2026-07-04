---
name: require-migration-safety-before-stop
enabled: true
event: stop
action: warn
pattern: drizzle/migrations|db:generate|scene_script_versions|selected_script_version|check-migrations
---

⚠️ **Migration work — confirm D1 safety before stopping**

If you touched **`drizzle/migrations/`** or added schema/backfill SQL this session:

**Required:**

```bash
bun scripts/check-migrations.ts drizzle/migrations/<dir>/migration.sql
```

Exit must be **0** (no destructive ops, no expensive backfill UPDATEs).

**If check fails:**

- Rewrite correlated `UPDATE`/`INSERT` as set-based `UPDATE … FROM` or windowed `JOIN` (#1019)
- Never use `DROP TABLE` / table rebuild — use additive `ALTER` + DML only (#612)
- Only bypass with explicit user approval: `--allow-destructive` / `--allow-expensive`

**Do not mark migration work complete** until the check passes or the user has explicitly waived it.
