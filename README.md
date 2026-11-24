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

## Conformance profiles, options and verification

Framework sources can use the layout of the Specification Framework's ARCH-ADR-7, ARCH-ADR-6 and ARCH-ADR-8. Sources that still use `requirements/` render as before, with warnings, so Building Blocks can migrate one at a time.

- **Conformance profiles (ARCH-ADR-7).** `toc.yml` lists `conformance-profiles` as one subsection per profile folder, with `introduction.md` first. The pages of a subsection resolve relative to that folder. Each introduction is served at the folder's route (`/conformance-profiles/<id>/`), because the folder name is the profile id. Its front matter (`type`, `description`, `requires`, `role`, `reference_architecture`) becomes a summary above the page. Functionality pages name their profile, the home page lists the profiles, and the sidebar groups each profile with a Core or Extension badge. Generation fails unless there is exactly one `CORE`, `requires` names only extension profiles without cycles, and the core requires nothing. A functionality missing from its introduction's links, `conformance` and `extension` fields, and `metadata.yml` `extensions` produce warnings and are ignored.
- **Options and conditions (ARCH-ADR-6).** Options listed under a variation point's `options` render as cards nested beneath it, with `select`, `key`, `extension` (linked to the profile that meets the option), `presented_by`, `applies_when` and `applies_when_all`. A generated *Options and conditions* page lists, for every option key and every extension profile used in a condition, the requirements that apply when it holds. Conditions link to it. Options count towards the requirement total. Structural rules (at least two options, `select.min`, `n.m` ids, no `interaction` on a variation point, the core meeting `min` without extensions) are reported as warnings.
- **Verification (ARCH-ADR-8).** With an `interaction`, a card shows how the requirement is verified: tested at that boundary, or audited against evidence for `INTERNAL`. `observability` is then not shown, and a value that disagrees is reported. Without an `interaction`, as in the cross-functional requirements, `observability` is shown as before.

A local link or image path that starts with `/` resolves against the specification's root, and is published under the build's `--base`. With `--base /bb/wallet/`, `/assets/cover.svg` becomes `/bb/wallet/assets/cover.svg`, so a specification only ever refers to its own assets. A path that escapes the root fails.

Decision records are not part of `toc.yml` yet. A Markdown page under `ADR/` that a published page links to is published as if it were listed under `resources`, with a warning, and its own links to other decision records are followed. Unlinked records are not published, and a link to any other unlisted Markdown page still fails.

`toc.yml` entries ending in `/` publish that folder's files with a download index, relative to their section, and fail if the folder does not exist. `terminology.yml` (`terms` with `term`/`definition`, or `entry` with `designation`/`description`) and `references.yml` render as pages, with one heading per term. Any other YAML page is shown verbatim.

## OpenAPI references

Framework sources can opt into Scalar references with `api-references.yml`:

```yaml
references:
  - id: consultation
    page: resources/api-reference.md
    contract: api/openapi.yaml
    role: normative
  - id: birth-registration
    page: resources/api-examples/birth-registration.md
    contract: api/examples/birth-registration.openapi.yaml
    role: example
```

Each `page` identifies a Markdown page in the source navigation. On these pages,
the renderer replaces the prose with native Scalar, a short role label, download
links, and closed technical metadata. There is no iframe or repeated introductory
response. Examples stay inside the owning contract. A missing local dependency
fails the build. An optional `operationId` and successful `response` pair can
validate a published response example; `example` selects a named example for
that pair. These selection fields are not needed to render a contract.

`role` is explicit: `normative` labels a draft transport contract, while `example`
labels an illustrative binding that adds no conformance requirements. Both the
navigation and reference page retain that distinction. Response values remain
illustrative even on a normative contract page.

Scalar 1.76.4 and bundled contracts are served locally, including project-subpath
deployments. Contract references must resolve inside the source repository;
remote references and escaping symlinks are rejected. Source contract bytes stay
unchanged and every dependency contributes to the source digest. API execution,
AI chat, and telemetry are disabled; references follow the site's theme.
Sources without this configuration retain their existing pages and navigation.
Operation-level `x-*` metadata is collected for every Building Block, without
requiring Digital Registries extensions. Built-output checks verify the native
host, role label, collapsed metadata, and bundled contract digest.

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

All previews bind to loopback. `npm run publish` builds several specifications into one site; see [Publishing several Building Blocks](#publishing-several-building-blocks).
`dev` generates source content once; regenerate after editing the authoritative
input. Use a static build plus `preview` to verify the Pagefind search index.

## Publishing several Building Blocks

[`publish/building-blocks.yml`](publish/building-blocks.yml) lists the Building Blocks to publish, each with an `id`, `title`, `repository` (`owner/name` on GitHub), `ref` (branch, tag or commit) and an optional `description`. `npm run publish` builds them into one static site:

```text
<output>/index.html     landing page listing the Building Blocks and the commit each was built from
<output>/bb/<id>/       one specification site per Building Block, built with the base <base>bb/<id>/
```

Every Building Block is built and then checked as in `build` and `test-served`. Any failure stops the run. Root paths in a specification resolve under its own `bb/<id>/` folder.

```sh
# Fetch each source at its ref, as CI does (checkouts go to .generated/publish-sources by default)
npm run publish -- --output /absolute/path/to/site --base / --unofficial
# Or build from local checkouts named after each repository, such as ../bb-wallet
npm run publish -- --sources .. --output /absolute/path/to/site --base /
python3 -m http.server 4336 --directory /absolute/path/to/site
```

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs the tests and the same command on every push to `main`, daily at 04:17 UTC, and when started by hand from the Actions tab (**Run workflow**). It then deploys the result to GitHub Pages. Building Block repositories do not trigger it: a new commit there reaches the site at the next daily run. To publish it sooner, run the workflow by hand. The site is at `https://<owner>.github.io/<repository>/bb/<id>/`. The base is `/<repository>/`, or `/` for a `<owner>.github.io` repository. Builds are marked unofficial. Deploying is opt-in: set the repository variable `PUBLISH_PAGES` to `true`, and set **Settings → Pages → Source** to **GitHub Actions**. Without the variable, pushes still build and check every Building Block, and the daily run is skipped. To add a Building Block, add it to the list; its repository must be public.

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
- The template's `specification-site/` directory is a thin framework wrapper
  that can be copied into a Building Block. It checks source-format and native
  Scalar compatibility before running the shared renderer.
- [`action.yml`](action.yml) provides a build-only composite GitHub Action.
  See [Building Block integration](docs/building-block-integration.md) for local
  setup, pinned CI consumption, and activation prerequisites.

## Not yet

The repository is available at
<https://github.com/jeremi/govstack-specification-site>. Consumers can pin a
published full commit; tagged releases are not required. The native Scalar
integration and composite action must be published before hosted consumers can
select them. A local checkout works through `GOVSTACK_SITE_RENDERER` meanwhile.

## Ownership and generated files

- `adapters/api-guide.mjs` reads the existing `SUMMARY.md`, Markdown,
  `rules.yaml`, and linter coverage contract without reclassifying its rules.
- `adapters/framework.mjs` treats root `README.md` and the pages listed in
  `toc.yml` as the complete page inventory, then reads functionality frontmatter
  and explicitly referenced support material.
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

The runtime content loader uses the manifest page allowlist. For framework
sources, a relative Markdown link must target root `README.md` or a page listed
in `toc.yml`; generation fails instead of silently adding another page.
Supporting HTML and redirects must also be declared explicitly. Generated
directories are ignored; change the input or generator rather than editing
generated content.
Starlight's Markdown processing includes the generated content directory, so
native heading permalinks and asides use the same transforms as ordinary docs.

Framework support files come from an explicit publication graph: page links,
images and reference definitions; raw HTML `href` and `src` attributes;
functionality `contract` and `test` values; and the source metadata downloads
`toc.yml`, `metadata.yml`, and `authors.yml`. A linked directory publishes its
allowed non-Markdown tree. Referenced YAML and JSON files add their local
`$ref` and `$dynamicRef` dependency closure. An `api-references.yml` contract
independently publishes its original source and local dependency closure as well
as the generated bundle; the configuration file itself is not a download.
Unreferenced repository files, including lockfiles and tooling, are not
published.

Hidden operational/configuration paths, including environment files, remain
excluded. Explicit `.well-known` publication assets and `.github` references
can be published. References or symlink aliases to excluded paths fail
generation. Static checks and output promotion also reject excluded paths,
including files left in an older output directory. Choose a fresh output rather
than deleting unrelated files.

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
