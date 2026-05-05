import { deleteFile, moveFile, getSignedUploadUrl } from '#storage';
import { getEnv } from '#env';
import { requireTeamAdminAccess } from '@/lib/auth/action-utils';
import { generateId } from '@/lib/db/id';
import type { Talent, TalentWithSheets } from '@/lib/db/schema';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import {
  createTalentSchema,
  createTalentSheetSchema,
  listTalentFilterSchema,
  updateTalentSchema,
} from '@/lib/schemas/talent.schemas';
import {
  STORAGE_BUCKETS,
  getPathFromUrl,
  getPublicUrl,
} from '@/lib/storage/buckets';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/lib/utils/file';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { LibraryTalentSheetWorkflowInput } from '@/lib/workflow/types';
import { computeLibraryTalentSheetHashFromDto } from '@/lib/workflows/sheet-snapshots';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

const talentIdSchema = z.object({ talentId: ulidSchema });
const sheetIdSchema = z.object({ sheetId: ulidSchema });
const mediaIdSchema = z.object({ mediaId: ulidSchema });
const characterIdSchema = z.object({ characterId: ulidSchema });

/**
 * Verify a talent record belongs to the given team, throwing if not found.
 * Uses scopedDb which is already team-scoped.
 */
async function requireTalentOwnership(
  scopedDb: {
    talent: { getById: (id: string) => Promise<Talent | undefined> };
  },
  talentId: string
): Promise<Talent> {
  const record = await scopedDb.talent.getById(talentId);
  if (!record) {
    throw new Error('Talent not found');
  }
  return record;
}

// List Talent

export const getTalentFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(listTalentFilterSchema.optional()))
  .handler(async ({ context, data }): Promise<TalentWithSheets[]> => {
    return context.scopedDb.talent.list({
      favoritesOnly: data?.favoritesOnly,
    });
  });

// Get Single Talent

export const getTalentByIdFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(talentIdSchema))
  .handler(async ({ context, data }) => {
    const talentRecord = await context.scopedDb.talent.getWithRelations(
      data.talentId
    );

    if (!talentRecord) {
      throw new Error('Talent not found');
    }

    return talentRecord;
  });

// Create Talent

export const createTalentFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(createTalentSchema))
  .handler(async ({ context, data }) => {
    const newTalent = await context.scopedDb.talent.create({
      name: data.name,
      description: data.description,
      isFavorite: data.isFavorite ?? false,
      isHuman: data.isHuman ?? false,
    });

    // Move temp files to permanent location and create media records
    const tempUrls = data.referenceImageUrls ?? [];
    const permanentUrls: string[] = [];

    if (getEnv().E2E_TEST === 'true') {
      for (const tempUrl of tempUrls) {
        const mediaId = generateId();
        permanentUrls.push(tempUrl);
        await context.scopedDb.talent.media.create({
          talentId: newTalent.id,
          type: 'image',
          url: tempUrl,
          path: `e2e-mock/${mediaId}`,
        });
      }
    } else {
      for (const tempUrl of tempUrls) {
        const tempPath = getPathFromUrl(tempUrl, STORAGE_BUCKETS.TALENT);
        const ext = getExtensionFromUrl(tempUrl);
        const mediaId = generateId();
        const permanentPath = `${context.teamId}/${newTalent.id}/${mediaId}.${ext}`;

        await moveFile(STORAGE_BUCKETS.TALENT, tempPath, permanentPath);

        const permanentUrl = getPublicUrl(
          STORAGE_BUCKETS.TALENT,
          permanentPath
        );
        permanentUrls.push(permanentUrl);

        await context.scopedDb.talent.media.create({
          talentId: newTalent.id,
          type: 'image',
          url: permanentUrl,
          path: permanentPath,
        });
      }
    }

    // Trigger talent sheet generation workflow asynchronously
    const workflowInput: LibraryTalentSheetWorkflowInput = {
      userId: context.user.id,
      teamId: context.teamId,
      talentId: newTalent.id,
      talentName: newTalent.name,
      talentDescription: newTalent.description ?? undefined,
      referenceImageUrls: [...permanentUrls].sort(),
      sheetName: 'Default Sheet',
    };
    workflowInput.snapshotInputHash =
      await computeLibraryTalentSheetHashFromDto(workflowInput);

    void triggerWorkflow('/library-talent-sheet', workflowInput, {
      label: buildWorkflowLabel(newTalent.id),
    }).catch((error) => {
      console.error(
        '[createTalentFn]',
        'Failed to trigger talent sheet workflow:',
        error
      );
    });

    return newTalent;
  });

// Update Talent

const updateTalentInputSchema = updateTalentSchema.extend({
  talentId: ulidSchema,
});

export const updateTalentFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(updateTalentInputSchema))
  .handler(async ({ context, data }) => {
    const { talentId, ...updateData } = data;

    const updated = await context.scopedDb.talent.update(talentId, updateData);

    if (!updated) {
      throw new Error('Talent not found or you do not have permission');
    }

    return updated;
  });

// Delete Talent (requires admin/owner role)

export const deleteTalentFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(talentIdSchema))
  .handler(async ({ context, data }) => {
    await requireTeamAdminAccess(context.user.id, context.teamId);

    const deleted = await context.scopedDb.talent.delete(data.talentId);
    if (!deleted) {
      throw new Error('Talent not found or failed to delete');
    }

    return { success: true };
  });

// Toggle Favorite

export const toggleTalentFavoriteFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(talentIdSchema))
  .handler(async ({ context, data }) => {
    const updated = await context.scopedDb.talent.toggleFavorite(data.talentId);

    if (!updated) {
      throw new Error('Talent not found or you do not have permission');
    }

    return updated;
  });

// Create Talent Sheet

export const createTalentSheetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(createTalentSheetSchema))
  .handler(async ({ context, data }) => {
    await requireTalentOwnership(context.scopedDb, data.talentId);

    return context.scopedDb.talent.sheets.create({
      talentId: data.talentId,
      name: data.name,
      imageUrl: data.imageUrl,
      imagePath: data.imagePath,
      metadata: data.metadata,
      isDefault: data.isDefault,
      source:
        data.source === 'ai_generated' ||
        data.source === 'manual_upload' ||
        data.source === 'script_analysis'
          ? data.source
          : 'manual_upload',
    });
  });

// Delete Talent Sheet

export const deleteTalentSheetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(sheetIdSchema))
  .handler(async ({ context, data }) => {
    const sheet = await context.scopedDb.talent.sheets.getById(data.sheetId);
    if (!sheet) {
      throw new Error('Sheet not found');
    }

    await requireTalentOwnership(context.scopedDb, sheet.talentId);

    const deleted = await context.scopedDb.talent.sheets.delete(data.sheetId);
    if (!deleted) {
      throw new Error('Failed to delete sheet');
    }

    return { success: true };
  });

// Set Default Sheet

export const setDefaultSheetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(sheetIdSchema))
  .handler(async ({ context, data }) => {
    const sheet = await context.scopedDb.talent.sheets.getById(data.sheetId);
    if (!sheet) {
      throw new Error('Sheet not found');
    }

    await requireTalentOwnership(context.scopedDb, sheet.talentId);

    const updated = await context.scopedDb.talent.sheets.update(data.sheetId, {
      isDefault: true,
    });
    if (!updated) {
      throw new Error('Failed to update sheet');
    }

    return updated;
  });

// Delete Talent Media

export const deleteTalentMediaFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(mediaIdSchema))
  .handler(async ({ context, data }) => {
    const media = await context.scopedDb.talent.media.getById(data.mediaId);
    if (!media) {
      throw new Error('Media not found');
    }

    await requireTalentOwnership(context.scopedDb, media.talentId);

    if (media.path) {
      try {
        await deleteFile(
          STORAGE_BUCKETS.TALENT,
          media.path.replace('talent/', '')
        );
      } catch {
        // Storage deletion is best-effort
      }
    }

    const deleted = await context.scopedDb.talent.media.delete(data.mediaId);
    if (!deleted) {
      throw new Error('Failed to delete media');
    }

    return { success: true };
  });

// Presigned Upload

const mediaTypeSchema = z.enum(['image', 'video', 'recording']);

export const presignTalentUploadFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        filename: z.string().min(1),
        type: mediaTypeSchema.optional(),
        talentId: ulidSchema.optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    if (data.talentId) {
      await requireTalentOwnership(context.scopedDb, data.talentId);
    }

    const ext = getExtensionFromUrl(data.filename);
    const mediaId = generateId();
    const contentType = getMimeTypeFromExtension(ext);

    const storagePath = data.talentId
      ? `${context.teamId}/${data.talentId}/${mediaId}.${ext}`
      : `${context.teamId}/temp/${mediaId}.${ext}`;

    const result = await getSignedUploadUrl(
      STORAGE_BUCKETS.TALENT,
      storagePath,
      contentType
    );

    return { ...result, mediaId };
  });

export const finalizeTalentUploadFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        talentId: ulidSchema,
        type: mediaTypeSchema,
        mediaId: ulidSchema,
        publicUrl: z.string().url(),
        path: z.string().min(1),
      })
    )
  )
  .handler(async ({ context, data }) => {
    if (!data.path.startsWith(`talent/${context.teamId}/`)) {
      throw new Error('Invalid storage path');
    }

    await requireTalentOwnership(context.scopedDb, data.talentId);

    await context.scopedDb.talent.media.create({
      id: data.mediaId,
      talentId: data.talentId,
      type: data.type,
      url: data.publicUrl,
      path: data.path,
    });

    return { success: true };
  });

// Generate Talent Sheet

const generateSheetInputSchema = z.object({
  talentId: ulidSchema,
  sheetName: z.string().optional(),
});

export const generateTalentSheetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(generateSheetInputSchema))
  .handler(async ({ context, data }) => {
    const talentRecord = await context.scopedDb.talent.getWithRelations(
      data.talentId
    );

    if (!talentRecord) {
      throw new Error('Talent not found');
    }

    const imageMedia =
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      talentRecord.media?.filter((m) => m.type === 'image') ?? [];
    if (imageMedia.length === 0) {
      throw new Error(
        'Talent must have at least one reference image to generate a sheet'
      );
    }

    const workflowInput: LibraryTalentSheetWorkflowInput = {
      userId: context.user.id,
      teamId: context.teamId,
      talentId: talentRecord.id,
      talentName: talentRecord.name,
      talentDescription: talentRecord.description ?? undefined,
      referenceImageUrls: imageMedia.map((m) => m.url).sort(),
      sheetName: data.sheetName,
    };
    workflowInput.snapshotInputHash =
      await computeLibraryTalentSheetHashFromDto(workflowInput);

    const runId = await triggerWorkflow(
      '/library-talent-sheet',
      workflowInput,
      {
        label: buildWorkflowLabel(talentRecord.id),
      }
    );
    return { runId };
  });

export const addCharacterToLibraryFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(characterIdSchema))
  .handler(async ({ context, data }) => {
    const character = await context.scopedDb.characters.getById(
      data.characterId
    );
    if (!character) {
      throw new Error('Character not found');
    }

    // Verify the character's sequence belongs to this team
    await context.scopedDb.sequences.getForUser({
      sequenceId: character.sequenceId,
    });

    const newTalent = await context.scopedDb.talent.create({
      name: character.name,
      description: character.physicalDescription ?? undefined,
      imageUrl: character.sheetImageUrl ?? undefined,
      imagePath: character.sheetImagePath ?? undefined,
      isFavorite: false,
      isHuman: false,
      isInTeamLibrary: true,
    });

    if (character.sheetImageUrl) {
      await context.scopedDb.talent.sheets.create({
        talentId: newTalent.id,
        name: 'Default',
        imageUrl: character.sheetImageUrl,
        imagePath: character.sheetImagePath ?? undefined,
        metadata: {
          characterId: character.characterId,
          name: character.name,
          age: character.age ?? '',
          gender: character.gender ?? '',
          ethnicity: character.ethnicity ?? '',
          physicalDescription: character.physicalDescription ?? '',
          standardClothing: character.standardClothing ?? '',
          distinguishingFeatures: character.distinguishingFeatures ?? '',
          consistencyTag: character.consistencyTag ?? '',
        },
        isDefault: true,
        source: 'script_analysis',
      });
    }

    return newTalent;
  });
