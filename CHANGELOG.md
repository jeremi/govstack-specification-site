# Changelog

All notable changes to the GovStack specification renderer are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

## 0.2.0 - 2026-11-24

This release renders the Specification Framework changes proposed for the Architecture Working Group meeting of 25 November 2026: conformance profiles (ARCH-ADR-7), options and conditional requirements (ARCH-ADR-6) and the removal of the `observability` classifier (ARCH-ADR-8). The Wallet Building Block 2.0 draft is the first specification to use all three. Specifications that still use `requirements/` render as before, with warnings, so that Building Blocks can migrate one at a time.

### Added

- **Conformance profiles (ARCH-ADR-7).**
  - `toc.yml` accepts a `conformance-profiles` section with one subsection per profile folder. The subsection's pages resolve relative to `conformance-profiles/<id>/`, and its `introduction.md` comes first.
  - Each profile's introduction is served at `/conformance-profiles/<id>/`, since the folder name is the profile id. A summary from its front matter (`type`, `description`, `requires`, `role`, `reference_architecture`) sits above it, along with the profiles it builds on and its number of functionalities.
  - Every functionality page names the conformance profile whose folder holds it, and its capabilities by title from `metadata.yml`.
  - The home page lists the profiles in a table: profile, id, type, what it builds on, description.
  - The sidebar groups each profile, with a Core or Extension badge.
  - The build manifest records each profile's id, type, title, `requires`, route and functionalities.
  - Generation fails when:
    - there is not exactly one `CORE` profile;
    - a `type` is neither `CORE` nor `EXTENSION`;
    - the core requires an extension;
    - `requires` names something that is not an extension profile, or forms a cycle;
    - a profile folder is not kebab-case, is listed twice, or does not list `introduction.md` first.
  - Warnings report:
    - functionalities that a profile's introduction does not link to, or that it links to in another profile;
    - pages outside a profile's `functionalities/` folder;
    - a remaining `requirements` section;
    - ignored `conformance` and `extension` fields, and an ignored `extensions` block in `metadata.yml`.
- **Options and conditional requirements (ARCH-ADR-6).**
  - Options listed under a variation point's `options` render as cards nested beneath it, each with its own id (such as `30.1`), level `OPTION`, key, badges, verification and test.
  - A variation point shows its selection ("Meet at least *min* of its *n* options", plus *max* when set).
  - An option met by claiming an extension links to that profile.
  - `presented_by`, `applies_when` and `applies_when_all` (on a requirement, or on a functionality as a whole) show their keys, each linked to the key's view.
  - A generated *Options and conditions* page is the "views by key" of ARCH-ADR-6. For every option key and every extension profile named in a condition, it lists the requirements that apply when it holds, grouped by functionality, with the option and its variation point at the top. It is in the sidebar under *Conformance profiles*.
  - Options count towards the requirement total that the served checks compare.
  - Warnings report:
    - variation points with fewer than two options, an invalid `select`, or an `interaction`, `test` or `api_operation_id`;
    - options without level `OPTION`, or with nested `select` or `options`;
    - option ids not numbered `n.m` after their variation point;
    - core variation points that cannot meet `min` without an extension;
    - duplicate keys;
    - conditions naming an unknown key or profile;
    - options met by an unknown extension;
    - `option_of`.
- **Verification method (ARCH-ADR-8).** A requirement with an `interaction` shows how it is verified: tested at that boundary, or, for `INTERNAL`, audited against evidence. Variation points are verified by counting the options that pass, and options met by an extension by the extension's tests. A requirement with neither `interaction` nor `observability` is shown as unclassified, with a warning.
- `toc.yml` entries ending in `/` publish that folder's files, relative to their section, with a download index and a sidebar link. A listed folder that does not exist fails the build.
- `terminology.yml` renders as a page with one heading per term. It shows the definition, abbreviation, notes, source, origin and related terms, and accepts both the `terms` (`term`/`definition`) and the `entry` (`designation`/`description`) forms. `references.yml` renders as a list of linked references with dates and abstracts. Any other YAML page is shown verbatim in a code block.
- Decision records: a Markdown page under `ADR/` that a published page links to is published under *Resources*, with a warning, and its links to other decision records are followed. Unlinked records are not published.
- Publishing several Building Blocks:
  - [`publish/building-blocks.yml`](publish/building-blocks.yml) lists the Building Blocks to publish: Wallet (`feat/v2.0`) and Document Management (`v0.6`).
  - [`scripts/publish.mjs`](scripts/publish.mjs) (`npm run publish`) fetches each source at its ref, or uses local checkouts with `--sources`. It builds and checks each one under `<base>bb/<id>/`, and writes a landing page that names the commit each was built from.
  - [`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs the tests and the publish command on every push to `main`, daily, and when started by hand. It deploys the result to GitHub Pages at `https://<owner>.github.io/<repository>/` when the repository variable `PUBLISH_PAGES` is `true`. Building Block repositories do not trigger it.
- Tests: [`tests/conformance-profiles.test.mjs`](tests/conformance-profiles.test.mjs) covers profiles, options, conditions, verification, folder entries, YAML pages, root paths and decision records with an abstract Building Block. [`tests/publish.test.mjs`](tests/publish.test.mjs) covers the publish list and landing page.
- README sections on conformance profiles, options and verification, and on publishing several Building Blocks.
- [`RELEASE_NOTES.md`](RELEASE_NOTES.md), with the steps for releasing a version of the renderer and the actions each kind of user takes when moving to it.

### Changed

- Version 0.2.0, up from 0.1.0.
- A local link or image path starting with `/` resolves against the specification's root and is published under the build base. For example, `/assets/cover.svg` built with `--base /bb/wallet/` becomes `/bb/wallet/assets/cover.svg`. A path that escapes the root fails. Previously such paths were left unchanged and their targets were not published.
- `observability` is shown only for requirements without an `interaction`, as in the cross-functional requirements. Where both are set, a warning says that `observability` is no longer read, and names both values when they disagree.
- Conditions are labelled *Applies when*, *Applies when any of* and *Applies when all of*, instead of *Any of* and *All of*.
- The requirements introduction counts options, and mentions "Unnumbered draft" only when a requirement has no id. It no longer calls every requirement an authoring draft.
- Sidebar section labels replace hyphens with spaces, so the section reads *Conformance profiles*, not *Conformance-profiles*.
- The adapter's source model (toc parsing, profiles, conditions, verification and YAML pages) moved into [`adapters/framework-model.mjs`](adapters/framework-model.mjs).

### Fixed

- `toc.yml` with subsections under any section, and an empty section such as `resources:` with no entries, no longer crash generation.
- Folder entries such as `api/` and `tests/` no longer fail with `EISDIR`, so `bb-template` builds again.
- `terminology.yml` and `references.yml` are no longer published as raw YAML under a Markdown page. They no longer get an HTML redirect written in place of the YAML file.
- An empty `documentation:` field no longer renders the text "null".
- A functionality description written as a YAML block scalar no longer ends with a stray line break.
- A `contract` or `test` given as a URN, such as `govstack:spec:bb:information-mediator`, is shown as written instead of becoming a broken local link. A web URL links as written. This fixes the Document Management build.

## 0.1.0

First version: the shared Astro/Starlight renderer with the `api-guide` and `framework` profiles, native Scalar OpenAPI references, built-output and HTTP checks, and the composite build action.
