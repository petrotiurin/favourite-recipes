// Recipe photos: found from a recipe's frontmatter `image:` ("/images/recipes/<slug>.jpg") among the files in images/recipes/, so Astro can
// make the smaller WebP copies the pages use (docs/typescript-migration.md 4.13). A recipe whose photo is missing fails the build.
import type { ImageMetadata } from "astro";

const photos = import.meta.glob<{ default: ImageMetadata }>("/images/recipes/*.{jpg,jpeg,png,webp}");

/** The photo a recipe's `image:` points at. Throws (failing the build) when there is no such file in images/recipes/. */
export async function photoFor(image: string, slug = image): Promise<ImageMetadata> {
  const load = photos[image.startsWith("/") ? image : `/${image}`];
  if (!load) throw new Error(`${slug}: its photo ${image} isn't in images/recipes/ (frontmatter "image:")`);
  return (await load()).default;
}

/**
 * How big each photo is shown, so the browser picks the smallest copy that is sharp. Widths are what gets made (each also at 2x/3x screens
 * by picking the next one up); `sizes` says how wide the photo is on screen:
 * - tile: a square, two to a row on a phone (about half the screen), auto-filled columns of at least 220px from 720px up (main is at most 1100px wide).
 * - hero: the full width of the page on a phone, at most the page's 1100px.
 * - thumb: the small round photos on the shopping page (at most 2.25rem, about 36px; 3x screens: 108px).
 */
export const PHOTO_SIZES = {
  tile: { widths: [240, 360, 540], sizes: "(min-width: 720px) 260px, 50vw", square: true },
  hero: { widths: [480, 800, 1200], sizes: "(min-width: 1100px) 1100px, 100vw", square: false },
  thumb: { widths: [72, 108], sizes: "36px", square: true },
} as const;

export type PhotoKind = keyof typeof PHOTO_SIZES;
