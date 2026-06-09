/**
 * Database Seed Script
 * Seeds the database with initial template styles and system team
 *
 * Usage:
 *   bun db:seed:local     # Wrangler local D1 (dev env)
 *   bun db:seed:test      # Wrangler local D1 (test env, isolated state)
 *   bun db:seed:d1        # Cloudflare D1 via HTTP API (production / CI)
 */

import { createD1HttpClient } from '@/lib/db/client-d1-http';
import { generateId } from '@/lib/db/id';
import {
  locationLibrary,
  locationSheets,
  styles,
  talent,
  talentSheets,
  teams,
} from '@/lib/db/schema';
import {
  DEFAULT_SYSTEM_LOCATIONS,
  getLocationSheetUrl,
} from '@/lib/location/location-templates';
import { DEFAULT_SYSTEM_STYLES } from '@/lib/style/style-templates';
import {
  DEFAULT_SYSTEM_TALENT,
  getTalentSheetUrl,
} from '@/lib/talent/talent-templates';
import { and, eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { getLocalPlatformProxy } from './local-platform-proxy';

const SYSTEM_TEAM_SLUG = 'system-templates';

// Old name → new name mappings for renamed templates
const RENAMES: Record<string, string> = {
  'Cinematic Drama': 'Award Season',
  'Documentary Realism': 'Documentary',
  'Action Blockbuster': 'Action',
  'Romantic Comedy': 'Rom-Com',
  'Animation Studio': 'Animated',
  'Wes Anderson Style': 'Pastel',
  'Lo-Fi iPhone 7 Aesthetic (Clean)': 'Lo-Fi Retro',
  YouTube: 'Animatic',
};

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    local: args.includes('--local'),
    test: args.includes('--test'),
    d1: args.includes('--d1'),
  };
}

async function seed() {
  const { local, test, d1 } = parseArgs();

  let platformProxy:
    | Awaited<ReturnType<typeof getLocalPlatformProxy<{ DB?: D1Database }>>>
    | undefined;
  let db: ReturnType<typeof drizzleD1> | ReturnType<typeof createD1HttpClient>;

  if (d1) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !databaseId || !token) {
      throw new Error(
        'CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, and CLOUDFLARE_API_TOKEN are required for --d1'
      );
    }
    console.log('🗄️  Using Cloudflare D1 via HTTP API\n');
    db = createD1HttpClient({
      accountId,
      databaseId,
      token,
    });
  } else if (test || local) {
    // getLocalPlatformProxy spins up Miniflare against the bindings defined in
    // wrangler.jsonc (test → [env.test] block) and hands back live D1/R2
    // bindings backed by the same SQLite files that `wrangler dev --env=test`
    // uses. Same code path as production via drizzle-orm/d1.
    const environment = test ? 'test' : undefined;
    console.log(
      `🗄️  Using Wrangler local D1 (${environment ?? 'default'} env)\n`
    );
    platformProxy = await getLocalPlatformProxy<{ DB?: D1Database }>({
      environment,
    });
    const d1Binding = platformProxy.env.DB;
    if (!d1Binding) {
      throw new Error(
        `[seed] D1 binding 'DB' missing from wrangler.jsonc ${environment ? `[env.${environment}]` : ''} — cannot seed.`
      );
    }
    db = drizzleD1(d1Binding);
  } else {
    throw new Error(
      'No database target specified. Use --local, --test, or --d1.'
    );
  }

  try {
    console.log('🌱 Seeding database...\n');

    // 1. Find or create system team
    console.log('Finding or creating system team...');
    let [systemTeam]: { id: string }[] = await db
      .select()
      .from(teams)
      .where(eq(teams.slug, SYSTEM_TEAM_SLUG));

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB query returns undefined when no rows match
    if (!systemTeam) {
      console.log('System team not found, creating...');
      const teamId = generateId();
      await db.insert(teams).values({
        id: teamId,
        name: 'System Templates',
        slug: SYSTEM_TEAM_SLUG,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      systemTeam = { id: teamId };
      console.log(`✅ System team created with ID: ${systemTeam.id}\n`);
    } else {
      console.log(`✅ System team found with ID: ${systemTeam.id}\n`);
    }

    // 2. Rename old template styles
    console.log('Checking for styles to rename...');
    const existingTemplates = await db
      .select()
      .from(styles)
      .where(eq(styles.teamId, systemTeam.id));

    const existingByName = new Map(existingTemplates.map((t) => [t.name, t]));
    let renamedCount = 0;

    for (const [oldName, newName] of Object.entries(RENAMES)) {
      const existing = existingByName.get(oldName);
      if (existing && !existingByName.has(newName)) {
        await db
          .update(styles)
          .set({ name: newName, updatedAt: new Date() })
          .where(eq(styles.id, existing.id));
        existingByName.set(newName, { ...existing, name: newName });
        existingByName.delete(oldName);
        renamedCount++;
        console.log(`   "${oldName}" → "${newName}"`);
      }
    }

    if (renamedCount > 0) {
      console.log(`✅ Renamed ${renamedCount} style(s)\n`);
    } else {
      console.log('✅ No renames needed\n');
    }

    // 3. Update existing templates and insert new ones
    console.log('Syncing template styles...');
    let insertedCount = 0;
    let updatedCount = 0;

    for (const template of DEFAULT_SYSTEM_STYLES) {
      const existing = existingByName.get(template.name);

      if (existing) {
        // Update all fields on existing template.
        // NOTE: sampleVideos is intentionally excluded — it's seeded
        // separately (scripts/seed-style-sample-videos.ts) and the template
        // mapper hardcodes it to [], so syncing it here would wipe seeded
        // sample videos.
        await db
          .update(styles)
          .set({
            description: template.description,
            category: template.category,
            tags: template.tags,
            config: template.config,
            isPublic: template.isPublic,
            isTemplate: template.isTemplate,
            previewUrl: template.previewUrl,
            sortOrder: template.sortOrder,
            recommendedImageModel: template.recommendedImageModel,
            recommendedVideoModel: template.recommendedVideoModel,
            defaultAspectRatio: template.defaultAspectRatio,
            useCases: template.useCases,
            updatedAt: new Date(),
          })
          .where(eq(styles.id, existing.id));
        updatedCount++;
      } else {
        // Insert new template
        await db.insert(styles).values({
          ...template,
          teamId: systemTeam.id,
          createdBy: null,
        } as typeof styles.$inferInsert);
        insertedCount++;
        console.log(`   + ${template.name}`);
      }
    }

    console.log(
      `✅ Synced templates: ${updatedCount} updated, ${insertedCount} inserted\n`
    );

    // 4. Sync system talent
    console.log('Syncing system talent...');
    const existingTalent = await db
      .select()
      .from(talent)
      .where(eq(talent.teamId, systemTeam.id));

    const existingTalentByName = new Map(
      existingTalent.map((t) => [t.name, t])
    );
    let talentInserted = 0;
    let talentUpdated = 0;

    for (const template of DEFAULT_SYSTEM_TALENT) {
      const existing = existingTalentByName.get(template.name);

      if (existing) {
        await db
          .update(talent)
          .set({
            description: template.description,
            isPublic: template.isPublic,
            isTemplate: template.isTemplate,
            isHuman: template.isHuman,
            imageUrl: template.imageUrl,
            updatedAt: new Date(),
          })
          .where(eq(talent.id, existing.id));
        talentUpdated++;
      } else {
        await db.insert(talent).values({
          ...template,
          teamId: systemTeam.id,
          createdBy: null,
        } as typeof talent.$inferInsert);
        talentInserted++;
        console.log(`   + ${template.name}`);
      }
    }

    console.log(
      `✅ Synced talent: ${talentUpdated} updated, ${talentInserted} inserted\n`
    );

    // 4b. Sync system talent sheets
    console.log('Syncing system talent sheets...');
    const allSystemTalent = await db
      .select()
      .from(talent)
      .where(eq(talent.teamId, systemTeam.id));

    let talentSheetsInserted = 0;

    for (const template of DEFAULT_SYSTEM_TALENT) {
      const talentRecord = allSystemTalent.find(
        (t) => t.name === template.name
      );
      if (!talentRecord) continue;

      // Check if a default sheet already exists
      const existingSheets = await db
        .select()
        .from(talentSheets)
        .where(
          and(
            eq(talentSheets.talentId, talentRecord.id),
            eq(talentSheets.isDefault, true)
          )
        );

      if (existingSheets.length > 0) continue;

      const sheetUrl = getTalentSheetUrl(template.name);
      await db.insert(talentSheets).values({
        id: generateId(),
        talentId: talentRecord.id,
        name: 'Default',
        imageUrl: sheetUrl,
        imagePath: `talent/${template.name.toLowerCase().replace(/\s+/g, '-')}/sheet.webp`,
        isDefault: true,
        source: 'ai_generated',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      talentSheetsInserted++;
      console.log(`   + ${template.name} — default sheet`);
    }

    console.log(`✅ Synced talent sheets: ${talentSheetsInserted} inserted\n`);

    // 5. Sync system locations
    console.log('Syncing system locations...');
    const existingLocations = await db
      .select()
      .from(locationLibrary)
      .where(eq(locationLibrary.teamId, systemTeam.id));

    const existingLocationsByName = new Map(
      existingLocations.map((l) => [l.name, l])
    );
    let locationsInserted = 0;
    let locationsUpdated = 0;

    for (const template of DEFAULT_SYSTEM_LOCATIONS) {
      const existing = existingLocationsByName.get(template.name);

      if (existing) {
        await db
          .update(locationLibrary)
          .set({
            description: template.description,
            isPublic: template.isPublic,
            isTemplate: template.isTemplate,
            referenceImageUrl: template.referenceImageUrl,
            updatedAt: new Date(),
          })
          .where(eq(locationLibrary.id, existing.id));
        locationsUpdated++;
      } else {
        await db.insert(locationLibrary).values({
          ...template,
          teamId: systemTeam.id,
          createdBy: null,
        } as typeof locationLibrary.$inferInsert);
        locationsInserted++;
        console.log(`   + ${template.name}`);
      }
    }

    console.log(
      `✅ Synced locations: ${locationsUpdated} updated, ${locationsInserted} inserted\n`
    );

    // 5b. Sync system location sheets
    console.log('Syncing system location sheets...');
    const allSystemLocations = await db
      .select()
      .from(locationLibrary)
      .where(eq(locationLibrary.teamId, systemTeam.id));

    let locationSheetsInserted = 0;

    for (const template of DEFAULT_SYSTEM_LOCATIONS) {
      const locationRecord = allSystemLocations.find(
        (l) => l.name === template.name
      );
      if (!locationRecord) continue;

      // Check if a default sheet already exists
      const existingSheets = await db
        .select()
        .from(locationSheets)
        .where(
          and(
            eq(locationSheets.locationId, locationRecord.id),
            eq(locationSheets.isDefault, true)
          )
        );

      if (existingSheets.length > 0) continue;

      const sheetUrl = getLocationSheetUrl(template.name);
      await db.insert(locationSheets).values({
        id: generateId(),
        locationId: locationRecord.id,
        name: 'Default',
        imageUrl: sheetUrl,
        imagePath: `locations/${template.name
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .replace(/\s+/g, '-')}/sheet.webp`,
        isDefault: true,
        source: 'ai_generated',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      locationSheetsInserted++;
      console.log(`   + ${template.name} — default sheet`);
    }

    console.log(
      `✅ Synced location sheets: ${locationSheetsInserted} inserted\n`
    );

    console.log('🎉 Database seeded successfully!');
  } catch (error) {
    console.error('❌ Error seeding database:', error);
    throw error;
  } finally {
    await platformProxy?.dispose();
  }
}

await seed();
