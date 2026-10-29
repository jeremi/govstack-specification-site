import path from 'node:path';
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';
import { readPublication, siteRoot } from '../scripts/publication.mjs';
import { summaryDocsLoader } from '../scripts/summary-loader.mjs';

const publication = readPublication();
const workspace = process.env.GOVSTACK_SITE_WORKSPACE || path.join(siteRoot, '.generated/api-guide');
export const collections = {
  docs: defineCollection({ loader: summaryDocsLoader(glob({ base: path.join(workspace, 'src/content/docs'), pattern: '**/[^_]*.md' }), publication.pages), schema: docsSchema() }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
