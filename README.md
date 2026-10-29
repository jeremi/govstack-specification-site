# GovStack specification renderer

One Astro/Starlight project renders GovStack specification sources with the
same branding, navigation, search, heading links, and verification tools. Each
kind of source has its own input adapter; the renderer is shared. Rendering must
not change normative meaning: adapters carry requirement text, identifiers, and
classifications through unchanged, and the canonical source repositories stay
authoritative.

## Profiles

| Profile | Input |
| --- | --- |
| `api-guide` | The API design guide: `SUMMARY.md`, Markdown, `rules.yaml`, and linter coverage |
| `framework` | A framework-format specification: `metadata.yml`, `authors.yml`, `toc.yml`, and Markdown |

Every profile requires an explicit source, either `--source` or the
`DOCS_SOURCE_ROOT` environment variable. There is no default, so a build cannot
silently pick up a different or dirty checkout.

## Local use

Use Node 24.11 or later. From this directory:

```sh
npm ci --ignore-scripts
npm run check -- --profile api-guide --source /absolute/path/to/api-design-guide
npm run preview -- --profile framework --source /absolute/path/to/specification --port 4336
```

`build`, `dev`, `generate`, `check:built`, and `test:served` accept the same
`--profile`, `--source`, `--output`, and `--base` options. Use the same source,
base and output when previewing or checking an existing build. A project subpath
works as follows:

```sh
npm run check -- --profile api-guide --source /absolute/path/to/api-design-guide --base /api-guide/ --output /absolute/path/to/scratch-output
```

All previews bind to loopback. No deployment or publication command is included.
`dev` generates source content once; regenerate after editing the authoritative
input. Use a static build plus `preview` to verify the Pagefind search index.

## Unofficial deployments

Pass `--unofficial` (or set `DOCS_UNOFFICIAL=1`) when a build is published
outside the GovStack process. Every page then carries a non-dismissible
"Unofficial preview" warning banner that links to https://specs.govstack.global/,
the preview label becomes "Unofficial preview", every HTML page (including
legacy redirects and download indexes) gets `<meta name="robots" content="noindex, nofollow">`,
and the site root gets a `robots.txt` with `User-agent: *` and `Disallow: /`.
`check-built` and `test-served` then also require the banner, `nofollow`, and
`robots.txt`. Without the flag, output is unchanged.

Crawlers honour `robots.txt` only at a host root. On a GitHub Pages project
subpath (for example `/govstack-api-design-guide/`) the file is not consulted,
so the meta tag is the effective control there.

`--source-url <github blob root>` (or `DOCS_SOURCE_URL`) sets where the
`api-guide` profile points "Edit page" and linter links. It must be an `https://`
URL without query or fragment, and contain `/blob/`; the edit root swaps `/blob/`
for `/edit/`. The default is the `bb-template/api-design-guide` location.
Example deploy build for a guide that lives at the root of its own repository:

```sh
npm run check -- --profile api-guide --source /absolute/path/to/govstack-api-design-guide --base /govstack-api-design-guide/ --unofficial --source-url https://github.com/jeremi/govstack-api-design-guide/blob/main
```

## Tests

`npm test` runs the fixture tests. Four tests need an external checkout and are
skipped, with the reason printed, unless these variables are set:

| Variable | Meaning |
| --- | --- |
| `GOVSTACK_API_GUIDE_SOURCE_ROOT` | The API design guide source |
| `GOVSTACK_API_GUIDE_RENDERER_ROOT` | The frozen previous API guide renderer used as the parity reference |
| `GOVSTACK_FRAMEWORK_SOURCE_ROOT` | A framework-format specification source |
| `GOVSTACK_FRAMEWORK_RENDERER_ROOT` | The frozen previous framework renderer used as the parity reference |

## Consumers

- `bb-template/api-design-guide-site` is a thin wrapper. Its npm scripts call
  this CLI with `--profile api-guide --source ../api-design-guide --output dist`.
  It finds the renderer at `../../govstack-specification-site` or at
  `GOVSTACK_SITE_RENDERER`.
- Framework-format specifications call the CLI directly with
  `--profile framework --source <specification>`.

## Not yet

The repository is published at
<https://github.com/jeremi/govstack-specification-site>, but there are no tagged
releases and no version pinning yet. Until tags exist, consumers point
`GOVSTACK_SITE_RENDERER` at a local checkout of this repository.

## Ownership and generated files

- `adapters/api-guide.mjs` reads the existing `SUMMARY.md`, Markdown,
  `rules.yaml`, and linter coverage contract without reclassifying its rules.
- `adapters/framework.mjs` reads `metadata.yml`, `authors.yml`, `toc.yml`,
  functionality frontmatter, and the declared linked/support material.
- `src/` owns the shared presentation. It contains no hand-maintained copies
  of either publication's prose or requirements.
- `scripts/publication.mjs` normalizes adapter output into a common manifest.
- `.generated/<profile>-<hash>/` is disposable renderer-owned scratch, where the hash is the first 12 hex characters of the SHA-256 of the canonical source path, so different sources never share a workspace. It holds the
  generated Markdown, support assets, adapter manifest, and `publication.json`.
- `dist/<profile>/` contains the independent static outputs. Builds for different
  profiles do not overwrite one another. Per-publication locks (keyed by profile and source path) protect generated
  workspaces; a shared lock serializes Astro's build workspace. Interrupted
  commands release their locks, and abandoned locks recover after their heartbeat expires.

Builds are checked in renderer-owned staging before copying to the requested
output, including outputs on another volume. Promotion preserves unrelated files
and refuses symlink destinations or obsolete HTML routes. Use a fresh output
directory when a publication intentionally removes a route.

The runtime content loader uses the manifest page allowlist. Supporting HTML and
redirects must also be declared explicitly. Generated directories are ignored;
change the input or generator rather than editing generated content.
Starlight's Markdown processing includes the generated content directory, so
native heading permalinks and asides use the same transforms as ordinary docs.

Framework support files exclude hidden operational/configuration paths, including
environment files. `.well-known` publication assets and `.github` references stay
available. References or symlink aliases to excluded paths fail generation.
Static checks and output promotion also reject excluded paths, including files
left in an older output directory. Choose a fresh output rather than deleting
unrelated files. The adapter still copies other allowed non-Markdown files;
limiting those to an explicit reference/dependency graph is separate work.

## Adapter boundary

Each adapter exports `generateSite({ sourceRoot, siteRoot, base })` and returns
its source-derived manifest. `siteRoot` is the generated workspace, never the
authoritative source tree. The common manifest contains:

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `profile` | Renderer schema and selected input adapter |
| `title`, `version`, `publicationKind` | Source identity; an unassigned formal kind stays null |
| `pages` | Source path, route, title, and source anchors for every permitted page |
| `sidebar` | Ordered navigation derived by the adapter |
| `supportFiles`, `supportIndexes`, `redirects` | Explicit support and compatibility output |
| `downloads` | Source/output mappings and labels for provenance links |
| `sourceRoot`, `sourceRevision`, `sourceDirty`, `sourceDigest` | Exact source location and snapshot provenance |
| `previewLabel`, `contentWidth`, `base` | Local presentation settings, separate from publication semantics |

The renderer labels its state **Local authoring preview** and adds `noindex`.
It does not assign a formal publication kind, issue requirement IDs or URNs,
map guide M/R notation to framework classifiers, or certify official compiler
compatibility. Existing requirement fields and documentation are retained by
the adapters. A framework `test` link identifies a reference, not a passed test.

## Checks

`npm run check` runs the tests, then Astro checks, a static build,
route/anchor/link/asset and Pagefind checks, then an isolated HTTP preview. The
HTTP checks request every page, validate downloads, 404 behavior, and structured
requirement totals. Browser QA covers search interaction, theme and mobile
behavior, diagrams, and heading-link spacing. Static checks alone do not
establish those interactions. Tests compare source bytes before and after
generation, with current Git state rather than a pinned session commit.

## License

The renderer is licensed under the [Apache License 2.0](LICENSE). The GovStack
logos in `src/assets/` belong to GovStack and are not covered by this license.
