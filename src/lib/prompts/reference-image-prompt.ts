/**
 * Result of building a prompt with character references
 */
export type PromptWithReferenceImages = {
  /** Enhanced prompt with character reference mapping appended */
  prompt: string;
  /** Array of character sheet URLs in order (for image_urls parameter) */
  referenceUrls: string[];
};

export type ReferenceImageDescription = {
  referenceImageUrl: string;
  description: string;
  /** Role distinguishes the primary scene from supporting reference images */
  role?: 'primary' | 'character' | 'location';
};

/**
 * Build a prompt with reference images, grouped by role.
 *
 * When a `role` is set on a reference, the prompt labels images by category
 * and instructs the model to treat non-primary images as likeness references
 * only — not as subjects to reproduce.
 *
 * @param basePrompt - The original prompt
 * @param references - The reference images (order determines Image numbering)
 * @param maxPromptLength - If set, truncate the base prompt to fit within this
 *   total limit while preserving the reference-images section in full.
 * @returns The enhanced prompt and ordered reference URLs
 */
export function buildReferenceImagePrompt(
  basePrompt: string,
  references: ReferenceImageDescription[],
  maxPromptLength?: number
): PromptWithReferenceImages {
  // strip any existing reference-images section from the prompt
  const promptWithoutReferenceImages = basePrompt.replace(
    /<reference-images>(.*\n)*<\/reference-images>|CHARACTER REFERENCES(.*\n)*$/s,
    ''
  );
  if (references.length === 0) {
    return {
      prompt: promptWithoutReferenceImages,
      referenceUrls: [],
    };
  }

  const hasRoles = references.some((r) => r.role);

  let referenceSection: string;

  if (hasRoles) {
    // Group by role for clearer model instructions
    const primary = references.filter((r) => r.role === 'primary');
    const characters = references.filter((r) => r.role === 'character');
    const locations = references.filter((r) => r.role === 'location');
    const other = references.filter((r) => !r.role);

    // Build ordered list: primary first, then characters, locations, other
    const ordered = [...primary, ...characters, ...locations, ...other];

    const lines: string[] = [];

    for (const ref of ordered) {
      const idx = ordered.indexOf(ref) + 1;
      switch (ref.role) {
        case 'primary':
          lines.push(`- Image ${idx} [PRIMARY SOURCE]: ${ref.description}`);
          break;
        case 'character':
          lines.push(`- Image ${idx} [CHARACTER REF]: ${ref.description}`);
          break;
        case 'location':
          lines.push(`- Image ${idx} [LOCATION REF]: ${ref.description}`);
          break;
        default:
          lines.push(`- Image ${idx}: ${ref.description}`);
      }
    }

    const instructionLines: string[] = [];
    if (primary.length > 0 && (characters.length > 0 || locations.length > 0)) {
      instructionLines.push(
        'IMPORTANT: Character and location reference images are for LIKENESS CONSISTENCY ONLY. Do NOT reproduce them as separate panels or subjects. All output panels must depict the scene from the PRIMARY SOURCE image.'
      );
    }

    referenceSection = `<reference-images>
    ${lines.join('\n    ')}
    ${instructionLines.length > 0 ? '\n    ' + instructionLines.join('\n    ') : ''}
  </reference-images>`;

    // Return URLs in the same order as the labeled list
    const combinedPrompt = `${promptWithoutReferenceImages}\n\n  ${referenceSection}`;
    return {
      prompt: truncateBasePrompt(
        promptWithoutReferenceImages,
        referenceSection,
        combinedPrompt,
        maxPromptLength
      ),
      referenceUrls: ordered.map((r) => r.referenceImageUrl),
    };
  }

  // Legacy path: no roles set, flat list
  const legacyRefSection = `<reference-images>
    ${references.map((reference, index) => `- Image ${index + 1}: ${reference.description}`).join('\n    ')}
  </reference-images>`;

  const combinedPrompt = `${promptWithoutReferenceImages}\n\n  ${legacyRefSection}`;
  return {
    prompt: truncateBasePrompt(
      promptWithoutReferenceImages,
      legacyRefSection,
      combinedPrompt,
      maxPromptLength
    ),
    referenceUrls: references.map((reference) => reference.referenceImageUrl),
  };
}

/**
 * Truncate the base prompt portion while preserving the reference-images section.
 * Returns the combined prompt unchanged when no limit is set or it already fits.
 */
function truncateBasePrompt(
  basePrompt: string,
  refSection: string,
  combinedPrompt: string,
  maxLength?: number
): string {
  if (!maxLength || combinedPrompt.length <= maxLength) return combinedPrompt;

  // joiner between base prompt and reference section
  const joiner = '\n\n  ';
  const available = maxLength - refSection.length - joiner.length - 3; // 3 for '...'

  if (available <= 0) {
    // Reference section alone exceeds limit — truncate the whole thing as a last resort
    console.warn(
      `[buildReferenceImagePrompt] Reference section (${refSection.length} chars) exceeds maxPromptLength (${maxLength})`
    );
    return combinedPrompt.slice(0, maxLength - 3) + '...';
  }

  console.warn(
    `[buildReferenceImagePrompt] Base prompt truncated from ${basePrompt.length} to ${available} chars (reference-images preserved)`
  );
  return basePrompt.slice(0, available) + '...' + joiner + refSection;
}
