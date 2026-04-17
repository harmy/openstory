/**
 * Type declarations for the content-collections virtual module.
 *
 * At dev/build time the @content-collections/vite plugin generates code into
 * .content-collections/generated/ and aliases "content-collections" to that
 * directory. This declaration provides types for standalone type-checking
 * (e.g. `bun tsgo --noEmit`) where the Vite alias is not active.
 */
declare module 'content-collections' {
  type Doc = {
    title: string;
    description: string;
    section: string;
    order: number;
    body: string;
    slug: string;
    content: string;
    _meta: {
      filePath: string;
      fileName: string;
      directory: string;
      extension: string;
      path: string;
    };
  };

  export const allDocs: Doc[];
}
