import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/**
 * One folder per location:
 *   src/content/locations/<slug>/location.yaml
 *   src/content/locations/<slug>/<photos>.jpg
 *
 * The build stops with a clear error if anything here is invalid
 * (missing photo file, coordinates out of range, malformed date...).
 */
const dateLike = z.union([z.string(), z.date()]).transform((v, ctx) => {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: 'custom', message: `"${v}" is not a valid date (use YYYY-MM-DD)` });
    return z.NEVER;
  }
  return d;
});

const locations = defineCollection({
  loader: glob({
    pattern: '*/location.yaml',
    base: './src/content/locations',
    generateId: ({ entry }) => entry.split('/')[0],
  }),
  schema: ({ image }) =>
    z
      .object({
        name: z.string().min(1),
        country: z.string().min(1),
        region: z.string().optional(),
        coordinates: z.object({
          lat: z.number().min(-90, 'Latitude must be between -90 and 90').max(90, 'Latitude must be between -90 and 90'),
          lng: z.number().min(-180, 'Longitude must be between -180 and 180').max(180, 'Longitude must be between -180 and 180'),
        }),
        description: z.string().default(''),
        notes: z.string().optional(),
        order: z.number().optional(),
        sample: z.boolean().default(false),
        /** "moon" puts the location on the Moon (coordinates are then lunar lat/lng). */
        body: z.enum(['earth', 'moon']).default('earth'),
        visits: z
          .array(z.object({ from: dateLike, to: dateLike.optional(), note: z.string().optional() }))
          .default([]),
        cover: image(),
        /** Which part of the cover stays visible when it is cropped (CSS object-position, e.g. "50% 30%"). */
        coverPosition: z.string().default('50% 50%'),
        photos: z
          .array(
            z.object({
              file: image(),
              title: z.string().default(''),
              /** Describes the photo for screen readers. Falls back to the title. */
              alt: z.string().optional(),
              caption: z.string().optional(),
              taken: dateLike.optional(),
              camera: z.string().optional(),
              lens: z.string().optional(),
              settings: z
                .object({
                  focal: z.string().optional(),
                  aperture: z.string().optional(),
                  shutter: z.string().optional(),
                  iso: z.union([z.string(), z.number()]).optional(),
                })
                .optional(),
              tags: z.array(z.string()).default([]),
              featured: z.boolean().default(false),
            }),
          )
          .min(1, 'A location needs at least one photo'),
      }),
});

export const collections = { locations };
