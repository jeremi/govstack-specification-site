# Building Block site integration

The shared renderer owns Scalar, its pinned dependencies, presentation, and
build checks. Each Building Block owns its Markdown, OpenAPI contracts, and
root `api-references.yml`. Existing GitBook publications are separate consumers;
adding this file does not modify their renderer or migrate their source layout.

## Local setup

Use Node 24.11 or later. Install this renderer with `npm ci --ignore-scripts`.
For a framework-format Building Block, run:

```sh
npm run check -- --profile framework --source /absolute/path/to/building-block --base /building-block/ --unofficial --output /absolute/path/to/preview
```

The source needs root `metadata.yml`, `authors.yml`, `toc.yml`, and Markdown.
The template's `specification-site/` wrapper supplies the same commands from a
Building Block repository, using an absolute `GOVSTACK_SITE_RENDERER` checkout.
It deliberately rejects an older renderer when API references are configured.

[`examples/building-block`](../examples/building-block/) is a runnable,
illustrative source fixture. It has no Digital Registries dependency:

```sh
npm run check -- --profile framework --source examples/building-block --base /building-block/ --unofficial --output /absolute/path/to/example-preview
```

## Declare API pages

Create a short Markdown page containing its title and list it in `toc.yml`.
Add an entry to root `api-references.yml` with `id`, `page`, `contract`, and
`role`. Set `role: normative` for the draft contract and `role: example` for an
illustrative binding. Keep those on separate pages. Do not add a requirement
just to make a contract visible.

The page displays the contract introduction, when supplied, and its operations,
with its role and downloads visible and technical metadata collapsed. The full
source contract remains available to download.
Local `$ref` dependencies are bundled; remote and escaping references fail the
build. Do not copy bundled JSON or Scalar assets into the source repository.

OpenAPI references are optional. AsyncAPI and protocol-standard surfaces keep
their existing documentation; this renderer does not convert them to OpenAPI.

## CI

After publishing a renderer revision containing `action.yml` and native Scalar,
check it out at an immutable full commit and use the local composite action:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
  with:
    path: specification
    persist-credentials: false
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
  with:
    repository: jeremi/govstack-specification-site
    ref: ${{ vars.GOVSTACK_SITE_RENDERER_REF }}
    path: renderer
    persist-credentials: false
- uses: ./renderer
  with:
    source: specification
    output: ${{ runner.temp }}/site
    base: /building-block/
    unofficial: 'true'
```

Set `GOVSTACK_SITE_RENDERER_REF` to the published full commit. Validate that it
is a 40-character hexadecimal commit before checkout, and reject a renderer
without `action.yml`, `scripts/api-references.mjs`, and
`src/components/ReferenceContent.astro`. Digital Registries' preview workflow
includes those checks. A repository or organisation variable lets consumers
share a deliberately selected revision; it must not contain a branch name.

The action installs Node and renderer dependencies, runs tests, checks Astro,
builds, checks output, and tests an isolated HTTP preview. It has no deployment
step or Pages permissions. An existing publication workflow can upload its
checked output and retain its own approval and deployment policy.

## Activation status

Local integration and hosted activation are distinct. Changing source config
does not upgrade a previously pinned renderer. Publish the reviewed renderer
change first, set the consumer's immutable revision, then run its site check.
Only after that succeeds should its existing publication process deploy it.
The template remains `noApi: true`; its config example stays inactive until an
adopting Building Block supplies its own contracts and framework source.
