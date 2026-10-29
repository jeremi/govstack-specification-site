# GovStack site branding

This site uses GovStack's own identity. It does not reuse Registry Stack branding or the theme from any GovStack presentation.

## First-party sources

Sources were reviewed and assets retrieved on 2026-10-29.

| Local use | First-party source | Treatment |
| --- | --- | --- |
| Brand guidance | <https://govstack.global/branding/> | Used to establish the official branding context and distinguish the plain GovStack mark from the collaboration lockup. |
| Color palette | <https://govstack.global/app/uploads/2026/08/GovStack-brand-colors.pdf> | Uses primary navy `#0a0050` and core blue `#0539e3`, yellow `#fec800`, red `#ff4042`, green `#2bc582`, and light gray `#e9e9e9`. |
| Header logo | <https://govstack.global/app/uploads/2023/08/logo.svg> | Copied to `src/assets/govstack-logo-blue.svg`. Geometry and official blue are unchanged; XML formatting is normalized. |
| Alternate white logo | <https://govstack.global/app/themes/govstack/assets/images/logo-white.svg> | Copied to `src/assets/govstack-logo-white.svg`. Geometry and paint are unchanged; XML formatting is normalized. It is not the primary mark on the documentation header. |
| Favicon | <https://govstack.global/app/uploads/2023/08/logo.svg> | Copied to `public/favicon.svg`. Geometry and official blue are unchanged; XML formatting is normalized. |
| Branding concept | <https://govstack.global/app/uploads/2024/05/GovStack_Branding-Concept_2024_external.pdf> | Consulted for identity scope. The partner-oriented “in collaboration with GovStack” lockup is not used. |

## Live site references

The live sites were reviewed on 2026-10-29 as implementation references. These observations describe the current sites, not additional rules in the branding guide.

- <https://govstack.global/> uses a white header with the official blue logo. Its content presentation uses Open Sans at approximately 18 px for body text and IBM Plex Sans at approximately 32 px and weight 800 for major headings, with navy heading color.
- <https://specs.govstack.global/> is the closer reference for this documentation site. It uses Inter at approximately 16 px with a 26 px line height for body text, and Inter at approximately 36 px and weight 700 for the primary heading. Its navigation is quiet and neutral: compact uppercase group labels, with active pages indicated by blue text and a thin blue bar rather than a filled pill.
- No proxied GitBook image URLs are recorded here. The logo asset comes directly from GovStack's main-site uploads path above.

## Site application

- The documentation header follows both live references: a white surface with the official blue GovStack wordmark.
- Body typography and navigation follow the documentation-specific Inter treatment from `specs.govstack.global`, rather than the Open Sans and IBM Plex Sans pairing used on the main institutional site.
- Body links and the active navigation marker use official blue. Other surfaces remain neutral so the brand colors are signals, not decoration.
- A pale yellow treatment marks draft status. Red and green are not used decoratively.
- Inter is self-hosted for interface and body text; code uses the platform monospace stack. The 2024 branding concept names Source Sans Pro for the collaboration lockup, but it does not describe the live documentation typography.
- Interface tints and neutral surfaces are derived for readable states. They are implementation colors, not additions to the official palette.

## Starlight configuration

Use the logo from the Astro configuration:

```js
logo: {
  light: './src/assets/govstack-logo-blue.svg',
  dark: './src/assets/govstack-logo-white.svg',
  alt: 'GovStack',
  replacesTitle: true,
}
```

Load the required self-hosted Inter weights and then `./src/styles/govstack.css` through Starlight's `customCss` option. Keep the configured site title as `Cross-BB API Design Guide`; the logo is the institutional identity, while the title names this publication.

The first visit defaults to the light documentation treatment. An explicit reader
choice of light, dark, or automatic theme is retained. The white wordmark is used
on the dark header only when a reader chooses a dark theme.

## Known constraint

GovStack's current public site publishes PNG favicons, not an SVG favicon. This project uses the unmodified official blue wordmark as an SVG favicon to avoid inventing or redrawing a GovStack symbol. The full wordmark may be less distinct at the smallest browser-tab sizes than a dedicated official icon would be.
