/**
 * Image Storage Service
 * Handles uploading and managing images in R2 Storage
 */

import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/lib/utils/file';
import { generateId } from '@/lib/db/id';

interface UploadImageOptions {
  imageUrl: string;
  teamId: string;
  sequenceId: string;
  shotId: string;
}

type StorageResult = {
  url: string;
  path: string;
};

/**
 * Upload an image from URL to R2 Storage
 * Uses ULID-based filename and preserves original file extension
 */
export async function uploadImageToStorage(
  options: UploadImageOptions
): Promise<StorageResult> {
  const { imageUrl, teamId, sequenceId, shotId } = options;

  // Download image from URL first to get content type
  const response = await fetch(imageUrl);

  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.statusText}`);
  }

  // Extract extension from URL or use response content-type
  const urlExtension = getExtensionFromUrl(imageUrl);
  const responseContentType = response.headers.get('content-type');

  // Prefer URL extension, fallback to content-type detection
  let extension = urlExtension;
  if (urlExtension === 'jpg' && responseContentType) {
    // If we defaulted to jpg, check if content-type suggests otherwise
    if (responseContentType.includes('png')) extension = 'png';
    else if (responseContentType.includes('webp')) extension = 'webp';
    else if (responseContentType.includes('gif')) extension = 'gif';
  }

  // Generate ULID-based filename
  const ulid = generateId();
  const storagePath = `teams/${teamId}/sequences/${sequenceId}/frames/${shotId}/${ulid}.${extension}`;

  // Get proper MIME type for the extension
  const contentType = getMimeTypeFromExtension(extension);

  // Stream directly to R2 Storage (avoids buffering entire image in memory)
  const result = await uploadResponse(
    response,
    STORAGE_BUCKETS.THUMBNAILS,
    storagePath,
    {
      contentType,
    }
  );

  return {
    url: result.publicUrl,
    path: storagePath,
  };
}
