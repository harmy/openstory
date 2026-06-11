/**
 * Video Storage Service
 * Handles uploading and managing videos in R2 Storage
 */

import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { getSignedUrlWithDownload } from '#storage';
import { uploadResponse } from '@/lib/storage/upload-response';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/lib/utils/file';
import { generateId } from '@/lib/db/id';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'motion', 'video-storage']);

type UploadVideoOptions = {
  videoUrl: string;
  teamId: string;
  sequenceId: string;
  frameId: string;
  sequenceTitle: string;
  sceneTitle?: string;
};

/**
 * Convert a string to a URL-safe slug
 * - Lowercase
 * - Replace spaces and special chars with hyphens
 * - Remove consecutive hyphens
 * - Trim hyphens from start/end
 * - Limit length to 50 chars
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

type StorageResult =
  | {
      success: true;
      url: string;
      path: string;
    }
  | {
      success: false;
      error: string;
    };

/**
 * Upload a video from URL to R2 Storage
 * Uses human-readable filename with short hash for uniqueness:
 * {sequence-slug}_{scene-slug}_{hash}_openstory.{ext}
 */
export async function uploadVideoToStorage(
  options: UploadVideoOptions
): Promise<StorageResult> {
  try {
    const { videoUrl, teamId, sequenceId, frameId, sequenceTitle, sceneTitle } =
      options;

    // Download video from URL first
    const response = await fetch(videoUrl);

    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.statusText}`);
    }

    // Extract extension from URL or use response content-type
    const urlExtension = getExtensionFromUrl(videoUrl);
    const responseContentType = response.headers.get('content-type');

    // Prefer URL extension, fallback to content-type detection
    let extension = urlExtension;
    if (urlExtension === 'jpg' && responseContentType) {
      // Default was jpg (fallback), check content-type for video formats
      if (responseContentType.includes('mp4')) extension = 'mp4';
      else if (responseContentType.includes('webm')) extension = 'webm';
      else if (
        responseContentType.includes('quicktime') ||
        responseContentType.includes('mov')
      )
        extension = 'mov';
      else extension = 'mp4'; // Default to mp4 for videos
    }

    // Generate human-readable filename with short hash for uniqueness
    // Use last 6 chars of ULID (from random portion) for better collision resistance
    // ULID structure: first 10 = timestamp, last 16 = random
    const ulid = generateId();
    const shortHash = ulid.slice(-6).toLowerCase();
    const sequenceSlug = slugify(sequenceTitle) || 'video';
    const sceneSlug = sceneTitle ? slugify(sceneTitle) : 'scene';
    const filename = `${sequenceSlug}_${sceneSlug}_${shortHash}_openstory.${extension}`;
    const storagePath = `teams/${teamId}/sequences/${sequenceId}/frames/${frameId}/${filename}`;

    logger.info(`Generated filename with hash: ${shortHash}`, {
      ulid,
      filename,
      frameId,
    });

    // Get proper MIME type for the extension
    const contentType = getMimeTypeFromExtension(extension);

    // Stream directly to R2 Storage (avoids buffering entire video in memory)
    const result = await uploadResponse(
      response,
      STORAGE_BUCKETS.VIDEOS,
      storagePath,
      {
        contentType,
      }
    );

    return {
      success: true,
      url: result.publicUrl,
      path: storagePath,
    };
  } catch (error) {
    logger.error('Upload failed:', { err: error });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload video',
    };
  }
}

/**
 * Generate a signed download URL with custom filename
 * Uses AWS ResponseContentDisposition to force browser download
 *
 * @param path - R2 storage path (e.g., 'teams/123/sequences/456/frames/789/motion.mp4')
 * @param filename - Download filename (e.g., 'desert-scene_openstory.mp4')
 * @param expiresIn - Expiration time in seconds (default: 3600 = 1 hour)
 */
export async function getVideoDownloadUrl(
  path: string,
  filename: string,
  expiresIn: number = 3600
): Promise<string> {
  const url = await getSignedUrlWithDownload(
    STORAGE_BUCKETS.VIDEOS,
    path,
    filename,
    expiresIn
  );

  return url;
}
