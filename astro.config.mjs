// @ts-check
import { defineConfig } from 'astro/config';

// GitHub Pages serves a project site from https://<user>.github.io/<repo>/,
// so every URL needs the repo name as a prefix ("base path").
// The deploy workflow sets SITE_URL and BASE_PATH automatically;
// locally they default to the site root.
const site = process.env.SITE_URL || 'http://localhost:4321';
const base = process.env.BASE_PATH || '/';

/**
 * Astro copies every imported photo into the build at full size, even when
 * only resized versions are used. This removes those unused originals after
 * the build so the published site stays small and full-size files stay private.
 */
function pruneUnusedOriginals() {
  return {
    name: 'prune-unused-originals',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const { readdir, readFile, rm } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const root = fileURLToPath(dir);
        const walk = async (d) =>
          (await readdir(d, { withFileTypes: true })).flatMap((e) =>
            e.isDirectory() ? [] : [join(d, e.name)],
          );
        const htmlFiles = [];
        const stack = [root];
        while (stack.length) {
          const d = stack.pop();
          for (const e of await readdir(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) stack.push(p);
            else if (/\.(html|css|js|json)$/.test(e.name)) htmlFiles.push(p);
          }
        }
        let text = '';
        for (const f of htmlFiles) text += await readFile(f, 'utf8');
        const assets = join(root, '_astro');
        let removed = 0;
        for (const f of await walk(assets).catch(() => [])) {
          const name = f.split(/[\\/]/).pop();
          if (/\.(jpe?g|png|tiff?|heic)$/i.test(name) && !text.includes(name)) {
            await rm(f);
            removed++;
          }
        }
        logger.info(`Removed ${removed} unused full-size originals from the build.`);
      },
    },
  };
}

export default defineConfig({
  site,
  base,
  integrations: [pruneUnusedOriginals()],
  trailingSlash: 'always',
  build: { format: 'directory' },
  image: {
    // Photos are resized at build time; nothing larger than this is ever published.
    responsiveStyles: false,
  },
  devToolbar: { enabled: false },
});
