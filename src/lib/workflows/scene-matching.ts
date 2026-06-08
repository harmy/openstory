/**
 * Scene matching utilities
 *
 * Pure functions for matching characters and locations to scenes
 * by their continuity tags. Used by analyze-script and frame-images workflows.
 */

import type {
  CharacterMinimal,
  SequenceElementMinimal,
  SequenceLocationMinimal,
} from '@/lib/db/schema';

type CharacterMatchInput = Pick<
  CharacterMinimal,
  'name' | 'characterId' | 'consistencyTag'
>;

// Tokenizes any cased/spaced/punctuated form into a set of snake_case-style
// word tokens, so `"Subject (Anonymous)"` and `"anonymous_subject_..."`
// share the {subject, anonymous} tokens regardless of order.
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSubset(needle: string[], haystack: Set<string>): boolean {
  if (needle.length === 0) return false;
  return needle.every((t) => haystack.has(t));
}

/**
 * Boolean: does any tag in `characterTags` refer to this character?
 *
 * Token-subset match: the character's `name` tokens must be a subset of
 * the tag's tokens (or vice versa for partial references). This is
 * invariant to case, spaces, punctuation, and word order — so
 * `"Subject (Anonymous)"` matches `"anonymous_subject_tattooed_..."`,
 * and `"jack"` no longer accidentally matches `"jacket_of_doom"`.
 *
 * `name` is the authoritative match key (stable across recast and what
 * the LLM is told to emit). `characterId` and `consistencyTag` are
 * fallbacks for legacy frames whose tags pre-date the prompt fix.
 */
export function matchCharacterToFrameTags(
  character: CharacterMatchInput,
  characterTags: string[]
): boolean {
  if (characterTags.length === 0) return false;

  const nameTokens = tokenize(character.name);
  const idTokens = tokenize(character.characterId);
  const consistencyTokens = character.consistencyTag
    ? tokenize(character.consistencyTag)
    : [];

  return characterTags.some((rawTag) => {
    const tagTokens = tokenize(rawTag);
    if (tagTokens.length === 0) return false;
    const tagSet = new Set(tagTokens);

    // Authoritative: name tokens
    if (isSubset(nameTokens, tagSet)) return true;
    // Reverse (partial name reference): tag is just part of the name
    const nameSet = new Set(nameTokens);
    if (isSubset(tagTokens, nameSet)) return true;

    // Fallback: characterId — tag must contain every characterId token
    if (isSubset(idTokens, tagSet)) return true;

    // Fallback: consistencyTag — both directions
    if (isSubset(consistencyTokens, tagSet)) return true;
    const consistencySet = new Set(consistencyTokens);
    if (isSubset(tagTokens, consistencySet)) return true;

    return false;
  });
}

/**
 * Match characters to a scene by their continuity tags.
 * Pure function that works in-memory without DB queries.
 */
export function matchCharactersToScene<T extends CharacterMatchInput>(
  allCharacters: T[],
  characterTags: string[]
): T[] {
  if (characterTags.length === 0) return [];
  return allCharacters.filter((c) =>
    matchCharacterToFrameTags(c, characterTags)
  );
}

type LocationMatchInput = Pick<
  SequenceLocationMinimal,
  'locationId' | 'name' | 'consistencyTag'
>;

/**
 * Match locations to a scene by environment tag or location name.
 * Pure function that works in-memory without DB queries.
 *
 * Generic so we can reuse it on `LocationBibleEntry` (same id/name/tag shape)
 * when narrowing the bible for prompt-input hashing.
 */
export function matchLocationsToScene<T extends LocationMatchInput>(
  allLocations: T[],
  environmentTag: string,
  sceneLocation: string
): T[] {
  if (!environmentTag && !sceneLocation) return [];

  const envTagLower = environmentTag.toLowerCase();
  const sceneLocLower = sceneLocation.toLowerCase();

  return allLocations.filter((loc) => {
    const consistencyTag = (loc.consistencyTag ?? '').toLowerCase();
    const locName = loc.name.toLowerCase();
    const locId = loc.locationId.toLowerCase();
    const searchTerms = [
      locName,
      locId,
      ...(consistencyTag ? [consistencyTag] : []),
    ].filter((t) => t.length > 0);

    // Forward match: a location identifier appears in the env/scene-location
    // tag. Reverse match: the env/scene-location tag appears in a location
    // identifier. Both directions guard against empty haystacks — without the
    // length check, `'forest'.includes('')` returns true for every location
    // when only one of envTagLower / sceneLocLower is populated.
    return searchTerms.some(
      (term) =>
        (envTagLower.length > 0 && envTagLower.includes(term)) ||
        (sceneLocLower.length > 0 && sceneLocLower.includes(term)) ||
        (envTagLower.length > 0 && term.includes(envTagLower)) ||
        (sceneLocLower.length > 0 && term.includes(sceneLocLower))
    );
  });
}

type ElementMatchInput = Pick<SequenceElementMinimal, 'token'> & {
  consistencyTag?: string | null;
};

/**
 * Derive the new canonical lowercase-kebab tag for an element. Prefer the
 * vision-LLM `consistencyTag` if populated; otherwise kebab-ify the legacy
 * token (`RED HEX LOGO` → `red-hex-logo`, `PEPSI_LOGO` → `pepsi-logo`).
 *
 * Kept here (not in components) so the server-side parser and the editor
 * stay in sync — both call into the same derivation. The mention-items UI
 * helper imports this.
 */
export function elementCanonicalKebab(el: ElementMatchInput): string {
  const fromConsistency = el.consistencyTag?.trim();
  if (fromConsistency) return fromConsistency;
  return (
    el.token
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || el.token
  );
}

/**
 * Match user-uploaded elements to a scene or prompt.
 *
 * Primary match: `elementTags[]` (emitted by the LLM during scene-split,
 * always UPPERCASE tokens).
 *
 * Fallback match: scan the text for either the UPPERCASE token (legacy
 * format the script still uses) OR the new lowercase-kebab tag that the
 * visual/motion-prompt LLM now emits. Catches references the model forgot
 * to put in `elementTags[]`, and is what the editor's `tagify` pill render
 * round-trips through after save.
 *
 * Generic so we can reuse it on `ElementBibleEntry` (same token + tag
 * shape) when narrowing the bible for prompt-input hashing.
 */
export function matchElementsToScene<T extends ElementMatchInput>(
  allElements: T[],
  elementTags: string[],
  sceneScript?: string
): T[] {
  if (allElements.length === 0) return [];

  const tagsUpper = new Set(elementTags.map((t) => t.toUpperCase()));
  const scriptUpper = (sceneScript ?? '').toUpperCase();
  const scriptRaw = sceneScript ?? '';

  return allElements.filter((el) => {
    const token = el.token.toUpperCase();
    if (tagsUpper.has(token)) return true;
    // Legacy uppercase whole-token match against the raw script. Escape the
    // token (it's arbitrary user text) so regex metacharacters can't false-match
    // or throw — matches the kebab branch below.
    const upperRe = new RegExp(
      `(?:^|[^A-Z0-9_])${escapeRegex(token)}(?:[^A-Z0-9_]|$)`
    );
    if (upperRe.test(scriptUpper)) return true;
    // New canonical kebab match. Boundary class excludes hyphen so the
    // multi-part slug `red-hex-logo` matches as a single token.
    const kebab = elementCanonicalKebab(el);
    if (kebab) {
      const kebabRe = new RegExp(
        `(?:^|[^A-Za-z0-9_-])${escapeRegex(kebab)}(?:[^A-Za-z0-9_-]|$)`,
        'i'
      );
      if (kebabRe.test(scriptRaw)) return true;
    }
    return false;
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
