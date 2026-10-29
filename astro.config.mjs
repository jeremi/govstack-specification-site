import path from 'node:path';
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';
import remarkGuideAnchors from './scripts/remark-guide-anchors.mjs';
import { readPublication, siteRoot } from './scripts/publication.mjs';

const publication = readPublication();
// readPublication() has already thrown if the workspace is unset.
const workspace = process.env.GOVSTACK_SITE_WORKSPACE;
export default defineConfig({
  base: process.env.DOCS_BASE || publication.base,
  output: 'static',
  outDir: process.env.DOCS_DIST_DIR || path.join(siteRoot, 'dist', publication.profile),
  publicDir: path.join(workspace, 'public'),
  cacheDir: path.join(workspace, '.astro'),
  vite: { cacheDir: path.join(workspace, '.vite'), build: { chunkSizeWarningLimit: 700 } },
  markdown: { processor: unified({ remarkPlugins: [remarkGuideAnchors] }) },
  integrations: [
    { name: '@astrojs/sitemap', hooks: {} },
    mermaid({ theme: 'default', autoTheme: true, enableLog: false }),
    starlight({
      title: publication.title,
      logo: { light: './src/assets/govstack-logo-blue.svg', dark: './src/assets/govstack-logo-white.svg', alt: 'GovStack', replacesTitle: true },
      defaultLocale: 'root',
      locales: { root: { label: 'English', lang: 'en' } },
      sidebar: publication.sidebar,
      customCss: ['@fontsource/inter/400.css', '@fontsource/inter/500.css', '@fontsource/inter/600.css', '@fontsource/inter/700.css', './src/styles/govstack.css'],
      components: {
        Header: './src/components/GuideHeader.astro',
        ThemeProvider: './src/components/GuideThemeProvider.astro',
        Banner: './src/components/PublicationBanner.astro',
        Footer: './src/components/PublicationFooter.astro',
      },
      head: [
        { tag: 'meta', attrs: { name: 'robots', content: 'noindex, follow' } },
        { tag: 'style', content: `:root { --publication-content-width: ${publication.contentWidth}; }` },
      ],
      pagination: true,
      markdown: { processedDirs: [path.join(workspace, 'src/content/docs')] },
      disable404Route: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
    }),
  ],
});
