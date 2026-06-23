import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppImage, isTransformableUrl } from './app-image';

const REMOTE_SRC = 'https://assets.openstory.so/sequences/abc/shot-1.png';

function renderImg(src: string) {
  return renderToStaticMarkup(
    <AppImage src={src} alt="" width={400} height={400} />
  );
}

describe('isTransformableUrl', () => {
  it('accepts same-zone https URLs', () => {
    expect(isTransformableUrl(REMOTE_SRC)).toBe(true);
    expect(isTransformableUrl('https://openstory.so/logo.png')).toBe(true);
  });

  it('rejects cross-origin sources — zone has any-origin resizing OFF (403)', () => {
    expect(isTransformableUrl('https://fal.media/files/abc/out.jpeg')).toBe(
      false
    );
    // suffix must be a label boundary, not a substring match
    expect(isTransformableUrl('https://evilopenstory.so/img.png')).toBe(false);
  });

  it('rejects local dev/e2e hosts', () => {
    expect(isTransformableUrl('http://localhost:4011/fixtures/img.png')).toBe(
      false
    );
    expect(isTransformableUrl('http://127.0.0.1:3000/img.png')).toBe(false);
  });

  it('rejects relative paths and non-http schemes', () => {
    expect(isTransformableUrl('/images/marketing/og.jpg')).toBe(false);
    expect(isTransformableUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isTransformableUrl('blob:https://openstory.so/some-id')).toBe(false);
  });
});

describe('AppImage', () => {
  it('routes remote images through Cloudflare Image Transformations', () => {
    const html = renderImg(REMOTE_SRC);

    // Transform URL shape: https://<zone-host>/cdn-cgi/image/<ops>/<source>
    expect(html).toContain('/cdn-cgi/image/');
    expect(html).toContain(REMOTE_SRC);
    // Graceful fallback to the original if the transform fails
    expect(html).toContain('onerror=redirect');
    // Bound inside the box without cropping — preserves source aspect ratio
    // (the provider default fit=cover would crop to a 400×400 square)
    expect(html).toContain('fit=scale-down');
    expect(html).not.toContain('fit=cover');
    // Responsive srcset so the browser downloads sized, not original, bytes
    expect(html).toMatch(/srcset=/i);
    expect(html).toContain('width=400');
    // unstyled: no injected inline styles — Tailwind classes at the call
    // sites control layout (object-contain/cover, max-w/h), as they did
    // before the CDN wrapper existed
    expect(html).not.toContain('style=');
  });

  it('leaves fal.media originals untransformed (any-origin resizing is off)', () => {
    const src = 'https://fal.media/files/abc/out.jpeg';
    const html = renderImg(src);
    expect(html).toContain(`src="${src}"`);
    expect(html).not.toContain('/cdn-cgi/image/');
  });

  it('falls back to a plain img for local URLs', () => {
    const src = 'http://localhost:4011/fixtures/img.png';
    const html = renderImg(src);
    expect(html).toContain(`src="${src}"`);
    expect(html).not.toContain('/cdn-cgi/image/');
  });

  it('falls back to a plain img for data URIs', () => {
    const src = 'data:image/png;base64,AAAA';
    const html = renderImg(src);
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).not.toContain('/cdn-cgi/image/');
  });
});
