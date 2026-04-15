/**
 * Database Seed Script
 * Seeds the database with initial template styles and system team
 *
 * Usage:
 *   bun db:seed           # Seed Turso database (requires TURSO_DATABASE_URL)
 *   bun db:seed:local     # Seed local SQLite database (file:local.db)
 *   bun db:seed:test      # Seed e2e test database (file:test.db)
 *   bun db:seed:d1        # Seed Cloudflare D1 via HTTP API
 */

import { createD1HttpClient } from '@/lib/db/client-d1-http';
import { styles, teams } from '@/lib/db/schema';
import { DEFAULT_SYSTEM_STYLES } from '@/lib/style/style-templates';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';

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

  let client: ReturnType<typeof createClient> | undefined;
  let db: ReturnType<typeof drizzle> | ReturnType<typeof createD1HttpClient>;

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
  } else if (test) {
    console.log('🗄️  Using e2e test database (file:test.db)\n');
    client = createClient({
      url: 'file:test.db',
    });
    db = drizzle(client);
  } else if (local) {
    console.log('🗄️  Using local SQLite database (file:local.db)\n');
    client = createClient({
      url: 'file:local.db',
    });
    db = drizzle(client);
  } else {
    const tursoUrl = process.env.TURSO_DATABASE_URL;
    const tursoToken = process.env.TURSO_AUTH_TOKEN;

    if (!tursoUrl) {
      throw new Error(
        'TURSO_DATABASE_URL is required (use --local for local.db)'
      );
    }

    console.log('🗄️  Using Turso database\n');
    client = createClient({
      url: tursoUrl,
      ...(tursoToken && { authToken: tursoToken }),
    });
    db = drizzle(client);
  }

  try {
    console.log('🌱 Seeding database...\n');

    // 1. Find or create system team
    console.log('Finding or creating system team...');
    const [systemTeam]: { id: string }[] = await db
      .select()
      .from(teams)
      .where(eq(teams.slug, SYSTEM_TEAM_SLUG));

    console.log(`✅ System team found with ID: ${systemTeam.id}\n`);

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
        // Update all fields on existing template
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

    console.log('🎉 Database seeded successfully!');
  } catch (error) {
    console.error('❌ Error seeding database:', error);
    throw error;
  } finally {
    client?.close();
  }
}

await seed();
