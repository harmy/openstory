/**
 * Decides whether an image/motion workflow run should record a `'user-edit'`
 * variant row.
 *
 * Auto paths (storyboard, smart-retry, scene-split previews, batch, etc.)
 * pass an assembled prompt that won't match the bare cached column on the
 * shot, so a string-equality check alone would mis-classify every auto run
 * as a phantom user edit. The `userEditedPrompt` flag is the source of truth;
 * the equality check guards against no-op edits where the user opened the
 * editor but didn't change anything.
 */
export const shouldRecordUserEdit = (args: {
  userEditedPrompt: boolean | undefined;
  prompt: string | undefined;
  currentPrompt: string | null | undefined;
}): boolean => {
  const { userEditedPrompt, prompt, currentPrompt } = args;
  if (!userEditedPrompt) return false;
  if (!prompt) return false;
  return prompt !== currentPrompt;
};
