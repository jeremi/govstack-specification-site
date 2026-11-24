# Release Notes

This file says what a developer does when the renderer's version goes up: the steps for releasing a version, and, for each version, the actions that maintainers, Building Block authors, renderer consumers and Pages publishers take to move to it. [CHANGELOG.md](CHANGELOG.md) lists every change in detail.

## Releasing a version

1. **Choose the number.** The renderer follows [Semantic Versioning](https://semver.org/). Until 1.0.0, the minor number marks changes that need action from anyone. The numbers go up as follows:
   - **Major:** a specification source that built before now fails, or the command line, the composite action's inputs or the build manifest change incompatibly.
   - **Minor:** the renderer accepts new source structures or renders more of them.
   - **Patch:** fixes only.
2. **Set the version** in `package.json` and `package-lock.json` together, without creating a tag yet:

   ```sh
   npm version <x.y.z> --no-git-tag-version
   ```

3. **Update [CHANGELOG.md](CHANGELOG.md).** Move the entries under *Unreleased* to a new `## <x.y.z> - <yyyy-mm-dd>` heading, and leave *Unreleased* empty above it.
4. **Add a section to this file** for the version, with the actions each kind of user takes, as for 0.2.0 below. Leave out a group that has nothing to do.
5. **Check the release** against the tests and every published Building Block:

   ```sh
   npm ci --ignore-scripts
   npm test
   npm run publish -- --output /absolute/path/to/scratch-site --base / --unofficial
   ```

   The publish run fetches each Building Block in `publish/building-blocks.yml` at its ref, then builds and checks it. Read the warnings in each `.generated/framework-*/publication.json`, and note in this file the ones Building Block authors need to act on.
6. **Commit and tag** on a branch, then merge into `main`:

   ```sh
   git commit -m "chore: release <x.y.z>"
   git tag -a v<x.y.z> -m "Release <x.y.z>"
   git push <remote> <branch> v<x.y.z>
   ```

   Push to the repository you publish the renderer from.
7. **Publish the site.** Where `PUBLISH_PAGES` is set, merging into `main` runs the Pages workflow and deploys the release. Check that the run in the **Actions** tab succeeded.
8. **Tell consumers** the full commit of the release, which they pin as `GOVSTACK_SITE_RENDERER_REF`, and point them to this file.

***

## Version 0.2.0

*Version date: 24 November 2026*

### Overview

The renderer now renders the Specification Framework changes proposed for the Architecture Working Group meeting of 25 November 2026:

- conformance profiles (ARCH-ADR-7);
- options and conditional requirements (ARCH-ADR-6);
- the verification method that follows from `interaction` (ARCH-ADR-8).

It also publishes several Building Blocks to GitHub Pages as one site. The Wallet Building Block 2.0 draft is the first specification to use all three changes. Sources that still use `requirements/` render as before, with warnings, so nothing has to migrate at once.

### Renderer maintainers

- Use Node 24.11 or later, with npm. If your Node install has no npm, reinstall Node, or use `corepack npm@11.6.2`.
- Run `npm ci --ignore-scripts` after pulling. Only the version in the lockfile changed, but this keeps `node_modules` matched to it.
- The source model now lives in `adapters/framework-model.mjs`. Toc parsing, profiles, conditions, verification and YAML pages belong there. Rendering stays in `adapters/framework.mjs`.

### Building Block authors

Migrating is optional in this version, but the warnings tell you what to change. To move a specification to the new layout:

1. **Conformance profiles.**
   - Replace `requirements/` with `conformance-profiles/<profile-id>/functionalities/`, one folder per profile. The folder name is the profile's permanent id, in kebab-case.
   - Give each profile an `introduction.md` whose front matter declares `title`, `type` (`CORE` or `EXTENSION`), `description`, `requires`, and optionally `role` and `reference_architecture`. A specification has exactly one `CORE`.
   - Link every functionality of the profile from its introduction.
2. **toc.yml.** Replace the `requirements` section with `conformance-profiles`, one subsection per profile folder, with `introduction.md` first:

   ```yaml
   conformance-profiles:
     - core-profile:
         - introduction.md
         - functionalities/functionality-a.md
   ```

3. **Remove** the `conformance` and `extension` fields from functionality files, and the `extensions` block from `metadata.yml`. They are now ignored.
4. **Options.**
   - List options under their variation point's `options`, with `level: OPTION` and ids `n.m`.
   - Give a `key` to each option that other requirements name in `applies_when`, and an `extension` to each option met by claiming an extension profile.
   - Replace `option_of` and file-level `cardinality` with `select` on the variation point.
5. **Verification.**
   - Set `interaction` on every requirement except variation points, and remove `observability`.
   - Use `INTERNAL` only for what cannot be seen at any boundary, and list the evidence in `documentation`.
   - A requirement with neither field shows as *Unclassified*.

Also check these behaviour changes, whether or not you migrate:

- **Root paths.** A link or image path starting with `/` now means the specification's root. A site built with `--base /bb/wallet/` turns `/assets/x.png` into `/bb/wallet/assets/x.png`. Write links to other Building Blocks or to `specs.govstack.global` as full `https://` URLs.
- **Folder entries.** A `toc.yml` entry ending in `/` names a folder relative to its section, so `resources: [tests/]` means `resources/tests/`. A missing folder now fails the build instead of being skipped.
- **Decision records.** A link to a Markdown page under `ADR/` publishes that page under *Resources*, with a warning. A link to any other Markdown page that `toc.yml` does not list still fails.
- **Terminology and references.** `terminology.yml` and `references.yml` now render as pages instead of raw YAML. `references.md` works as before.
- **Contracts and tests.** A URN in `contract` or `test`, such as `govstack:spec:bb:information-mediator`, is shown as text instead of a broken link.

After building, read `warnings` in `.generated/framework-*/publication.json`. It names each source line to correct.

### Renderer consumers

These steps apply to CI that pins the renderer or uses `action.yml`:

- **Pin the new commit.** Set `GOVSTACK_SITE_RENDERER_REF` to the full commit of the 0.2.0 release in the renderer repository you use. The action's inputs are unchanged.
- **Update anything that reads the build manifest (`publication.json`):**
  - `requirementCount` now includes options;
  - `profiles` lists the conformance profiles;
  - a generated page is marked `generated: true` and has no source file;
  - `.yml` pages have no legacy `.html` redirect.
- **Update anything that reads rendered requirement cards:**
  - options are `requirement-card option` elements nested inside their variation point's card;
  - conditions are labelled *Applies when*, *Applies when any of* and *Applies when all of*, instead of *Any of* and *All of*;
  - *Verification* is a new row.

### Pages publishers

- **Enable GitHub Actions once.** On a fork they start disabled: open the **Actions** tab and enable workflows.
- **Opt in to deploying:** in **Settings → Secrets and variables → Actions → Variables**, set the repository variable `PUBLISH_PAGES` to `true`. Without it, the workflow builds and checks on pushes but never deploys, and skips the daily run.
- **Set the Pages source:** in **Settings → Pages**, set **Source** to **GitHub Actions**.
- **List the Building Blocks** in `publish/building-blocks.yml`. Each needs an `id`, `title`, `repository` and `ref`, and its repository must be public. A Building Block that fails its checks stops the whole deploy.
- **When it runs.** The workflow runs on every push to `main` and daily at 04:17 UTC, and publishes at `https://<owner>.github.io/<repository>/bb/<id>/`, marked as an unofficial preview.
- **Publishing a Building Block change sooner.** Building Block repositories do not trigger the workflow, so their changes otherwise wait for the next daily run. To publish one sooner, go to **Actions → Publish specifications to GitHub Pages → Run workflow** on `main`.
- **Re-enabling the schedule.** GitHub disables a scheduled workflow after 60 days without activity in this repository. If that happens, re-enable it from the **Actions** tab.
