// Source model of a framework-format specification: toc.yml structure, conformance
// profiles (ARCH-ADR-7), options and conditions (ARCH-ADR-6), and the verification
// method that follows from a requirement's interaction (ARCH-ADR-8).
//
// Nothing here changes normative content. It reads front matter, checks the
// structural rules the renderer depends on, and reports the rest as warnings.

import path from 'node:path';

import YAML from 'yaml';

export const PROFILE_SECTION = 'conformance-profiles';
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROFILE_TYPES = new Set(['CORE', 'EXTENSION']);

function assertSafeEntry(entry, where) {
  if (typeof entry !== 'string' || !entry.trim()) {
    throw new Error(`toc.yml: ${where}: every entry must be a file or folder name`);
  }
  if (path.posix.isAbsolute(entry) || entry.split('/').includes('..')) {
    throw new Error(`toc.yml: ${where}: entry must stay inside its section: ${entry}`);
  }
}

// Reads toc.yml into ordered sections. A section's items are pages, folders (an
// entry ending in "/"), titled subsections, or, under conformance-profiles, one
// subsection per profile whose pages resolve relative to the profile's folder.
export function parseToc(toc) {
  const sections = [];
  const ordered = ['README.md'];
  const seen = new Set(ordered);
  const folders = [];
  const profiles = [];

  function entryItem(directory, entry, where) {
    assertSafeEntry(entry, where);
    const source = path.posix.join(directory, entry);
    if (entry.endsWith('/')) {
      const folder = source.replace(/\/+$/, '');
      folders.push(folder);
      return { kind: 'folder', source: folder };
    }
    if (seen.has(source)) throw new Error(`toc.yml: ${source} is listed twice`);
    seen.add(source);
    ordered.push(source);
    return { kind: 'page', source };
  }

  for (const [section, entries] of Object.entries(toc)) {
    if (entries === null || entries === undefined) {
      sections.push({ key: section, items: [] });
      continue;
    }
    if (!Array.isArray(entries)) throw new Error(`toc.yml: ${section} must be a list`);
    const items = entries.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        if (section === PROFILE_SECTION) {
          throw new Error(
            `toc.yml: ${PROFILE_SECTION} lists one subsection per profile folder, not the page ${JSON.stringify(entry)}`,
          );
        }
        return entryItem(section, entry, section);
      }
      const names = Object.keys(entry);
      if (names.length !== 1 || !names[0].trim()) {
        throw new Error(`toc.yml: ${section}: a subsection has exactly one non-empty title`);
      }
      const [name] = names;
      const children = entry[name];
      if (!Array.isArray(children) || !children.length) {
        throw new Error(`toc.yml: ${section}: subsection ${name} has no pages`);
      }
      for (const child of children) {
        if (child && typeof child === 'object') {
          throw new Error(`toc.yml: ${section}: subsection ${name} contains another subsection; subsections are one level deep`);
        }
      }
      if (section !== PROFILE_SECTION) {
        return {
          kind: 'group',
          label: name,
          items: children.map((child) => entryItem(section, child, `${section}/${name}`)),
        };
      }
      if (!KEBAB.test(name)) {
        throw new Error(`toc.yml: conformance profile folder ${name} must be kebab-case; the folder name is the profile id`);
      }
      if (profiles.some((profile) => profile.id === name)) {
        throw new Error(`toc.yml: conformance profile ${name} is listed twice`);
      }
      if (children[0] !== 'introduction.md') {
        throw new Error(`toc.yml: conformance profile ${name} must list introduction.md first`);
      }
      const directory = path.posix.join(section, name);
      const profileItems = children.map((child) => entryItem(directory, child, directory));
      const pages = profileItems.filter((item) => item.kind === 'page').map((item) => item.source);
      profiles.push({ id: name, directory, introduction: pages[0], pages });
      return { kind: 'profile', id: name, items: profileItems };
    });
    sections.push({ key: section, items });
  }
  return { sections, ordered, pageSources: new Set(ordered), folders, profiles };
}

// The profile that a page belongs to, by where its file is.
export function profileForSource(profiles, source) {
  return profiles.find((profile) => source.startsWith(`${profile.directory}/`));
}

function asList(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

// Completes each profile from the front matter of its introduction and checks the
// rules of ARCH-ADR-7 that the rendered navigation and links depend on.
export function resolveProfiles(tocProfiles, pagesBySource, warnings) {
  const profiles = tocProfiles.map((profile) => {
    const page = pagesBySource.get(profile.introduction);
    const frontmatter = page.frontmatter;
    if (!PROFILE_TYPES.has(frontmatter.type)) {
      throw new Error(`${profile.introduction}: type must be CORE or EXTENSION, found ${JSON.stringify(frontmatter.type ?? null)}`);
    }
    const functionalities = profile.pages.filter((source) => source !== profile.introduction);
    for (const source of functionalities) {
      if (!source.startsWith(`${profile.directory}/functionalities/`)) {
        warnings.push(`${source}: pages of a conformance profile other than its introduction belong in its functionalities/ folder`);
      }
    }
    if (!functionalities.length) warnings.push(`${profile.introduction}: conformance profile ${profile.id} lists no functionality`);
    return {
      ...profile,
      title: page.title,
      type: frontmatter.type,
      description: typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '',
      requires: asList(frontmatter.requires),
      role: frontmatter.role ? String(frontmatter.role) : '',
      referenceArchitecture: frontmatter.reference_architecture ? String(frontmatter.reference_architecture) : '',
      functionalities,
    };
  });
  if (!profiles.length) return profiles;
  const cores = profiles.filter((profile) => profile.type === 'CORE');
  if (cores.length !== 1) {
    throw new Error(
      `toc.yml: a specification has exactly one CORE conformance profile, found ${cores.length}${cores.length ? ` (${cores.map((profile) => profile.id).join(', ')})` : ''}`,
    );
  }
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  for (const profile of profiles) {
    if (profile.type === 'CORE' && profile.requires.length) {
      throw new Error(`${profile.introduction}: the core never depends on an extension, but requires ${profile.requires.join(', ')}`);
    }
    for (const id of profile.requires) {
      if (byId.get(id)?.type !== 'EXTENSION') {
        throw new Error(`${profile.introduction}: requires ${id}, which is not an extension profile in toc.yml`);
      }
    }
  }
  const visiting = new Set();
  const done = new Set();
  function visit(profile, trail) {
    if (done.has(profile.id)) return;
    if (visiting.has(profile.id)) {
      throw new Error(`toc.yml: conformance profiles require each other in a cycle: ${[...trail, profile.id].join(' → ')}`);
    }
    visiting.add(profile.id);
    for (const id of profile.requires) visit(byId.get(id), [...trail, profile.id]);
    visiting.delete(profile.id);
    done.add(profile.id);
  }
  for (const profile of profiles) visit(profile, []);
  return profiles;
}

// Each functionality listed in an introduction's Functionalities table is a file of
// that profile, and each file of the profile is listed (ARCH-ADR-7, compiler checks).
export function checkProfileFunctionalityLinks(profile, linkedTargets, warnings) {
  const listed = new Set(linkedTargets.filter((target) => target.startsWith(`${profile.directory}/functionalities/`)));
  for (const target of linkedTargets) {
    if (/\/functionalities\/[^/]+\.md$/.test(target) && !target.startsWith(`${profile.directory}/`)) {
      warnings.push(`${profile.introduction}: links to ${target}, a functionality of another conformance profile`);
    }
  }
  for (const source of profile.functionalities) {
    if (!listed.has(source)) warnings.push(`${profile.introduction}: does not link to its functionality ${source}`);
  }
}

// All requirements of a functionality, with options flattened after their
// variation point, each with the anchor its card is rendered under.
export function flattenRequirements(requirements = []) {
  const flat = [];
  requirements.forEach((requirement, index) => {
    const anchor = `requirement-${index + 1}`;
    flat.push({ requirement, anchor, parent: undefined });
    (Array.isArray(requirement?.options) ? requirement.options : []).forEach((option, optionIndex) => {
      flat.push({ requirement: option, anchor: `${anchor}-option-${optionIndex + 1}`, parent: requirement });
    });
  });
  return flat;
}

// Indexes the keys of options and the ids of extension profiles, which are the
// names applies_when, applies_when_all and presented_by may use, and collects the
// requirements that each name makes apply (the views by key of ARCH-ADR-6).
export function collectConditions(functionalityPages, profiles, warnings) {
  const names = new Map();
  for (const profile of profiles) {
    if (profile.type === 'EXTENSION') names.set(profile.id, { kind: 'extension', name: profile.id, profile, uses: [] });
  }
  for (const page of functionalityPages) {
    for (const entry of flattenRequirements(page.frontmatter.requirements)) {
      const key = entry.requirement?.key;
      if (!entry.parent || key === undefined || key === null || key === '') continue;
      const name = String(key);
      if (names.has(name)) {
        warnings.push(`${page.sourceName}: option key ${name} is not unique across the options and extension profiles of the specification`);
        continue;
      }
      names.set(name, { kind: 'option', name, page, ...entry, uses: [] });
    }
  }
  const profileIds = new Set(profiles.map((profile) => profile.id));
  for (const page of functionalityPages) {
    const fileConditions = asList(page.frontmatter.applies_when);
    const fileAllConditions = asList(page.frontmatter.applies_when_all);
    for (const name of [...fileConditions, ...fileAllConditions]) {
      if (!names.has(name)) warnings.push(`${page.sourceName}: applies_when names ${name}, which is neither an option key nor an extension profile`);
      else names.get(name).uses.push({ page, anchor: undefined, requirement: undefined, mode: fileAllConditions.includes(name) ? 'all' : 'any' });
    }
    for (const entry of flattenRequirements(page.frontmatter.requirements)) {
      const requirement = entry.requirement ?? {};
      for (const [field, mode] of [['applies_when', 'any'], ['applies_when_all', 'all']]) {
        for (const name of asList(requirement[field])) {
          if (!names.has(name)) {
            warnings.push(`${page.sourceName}: ${field} names ${name}, which is neither an option key nor an extension profile`);
            continue;
          }
          names.get(name).uses.push({ page, ...entry, mode });
        }
      }
      for (const name of asList(requirement.presented_by)) {
        if (!names.has(name)) warnings.push(`${page.sourceName}: presented_by names ${name}, which is neither an option key nor an extension profile`);
      }
      if (requirement.extension !== undefined && requirement.extension !== null && requirement.extension !== '') {
        const extension = String(requirement.extension);
        if (!entry.parent) {
          // A requirement-level `extension` is the legacy ARCH-ADR-7 Option 3 field, handled by the caller.
        } else if (!profileIds.size) {
          warnings.push(`${page.sourceName}: option is met by claiming ${extension}, but the specification declares no conformance profiles`);
        } else if (names.get(extension)?.kind !== 'extension') {
          warnings.push(`${page.sourceName}: option is met by claiming ${extension}, which is not an extension profile in toc.yml`);
        }
      }
    }
  }
  return names;
}

// Structural checks on variation points and options (ARCH-ADR-6). They are warnings:
// drafts are rendered as written so that Working Groups can see what to correct.
export function checkOptions(page, profile, warnings) {
  for (const requirement of page.frontmatter.requirements ?? []) {
    if (!requirement || typeof requirement !== 'object') continue;
    if (requirement.option_of !== undefined) {
      warnings.push(`${page.sourceName}: option_of is replaced by listing options beneath their variation point (ARCH-ADR-6)`);
    }
    const options = Array.isArray(requirement.options) ? requirement.options : undefined;
    if (requirement.level === 'OPTION' && !options) {
      warnings.push(`${page.sourceName}: a requirement with level OPTION sits in the options list of a variation point`);
    }
    if (!requirement.select && !options) continue;
    if (!requirement.select || !options) {
      warnings.push(`${page.sourceName}: a variation point needs both select and options`);
      continue;
    }
    const min = requirement.select.min ?? 1;
    if (options.length < 2) warnings.push(`${page.sourceName}: a variation point has at least two options`);
    if (!(Number.isInteger(min) && min >= 1 && min <= options.length)) {
      warnings.push(`${page.sourceName}: select.min must be at least 1 and no greater than the number of options`);
    }
    if (requirement.select.max !== undefined && !(Number.isInteger(requirement.select.max) && requirement.select.max >= min)) {
      warnings.push(`${page.sourceName}: select.max must be at least select.min`);
    }
    for (const field of ['interaction', 'test', 'api_operation_id']) {
      if (requirement[field]) warnings.push(`${page.sourceName}: a variation point carries no ${field}; it is verified by counting the options that pass`);
    }
    const parentId = requirement.id ? String(requirement.id) : '';
    for (const option of options) {
      if (option?.level !== 'OPTION') warnings.push(`${page.sourceName}: option ${option?.key || option?.id || '(unnamed)'} must have level OPTION`);
      if (option?.select || option?.options) warnings.push(`${page.sourceName}: an option has no select and no options`);
      const optionId = option?.id ? String(option.id) : '';
      if (optionId && (!parentId || !optionId.startsWith(`${parentId}.`) || !/^\d+$/.test(optionId.slice(parentId.length + 1)))) {
        warnings.push(`${page.sourceName}: option ${optionId} must be numbered ${parentId || 'n'}.m after its variation point`);
      }
    }
    if (profile?.type === 'CORE') {
      const withoutExtension = options.filter((option) => !option?.extension).length;
      if (withoutExtension < min) {
        warnings.push(`${page.sourceName}: in the core, at least select.min options of a variation point are met without an extension`);
      }
    }
  }
}

const BOUNDARY = {
  SERVICE_API: 'Service API',
  CONSUMED_API: 'consumed API',
  PROTOCOL: 'protocol',
  EVENT: 'event',
  USER_INTERFACE: 'user interface',
  DEVICE: 'device',
  FILE: 'file',
};

// How a requirement is verified (ARCH-ADR-8). With an interaction, the method
// follows from it and observability is no longer read. Without one, as in the
// cross-functional requirements, observability is read as before.
export function verificationOf(requirement, { isVariationPoint, isExtensionOption }) {
  if (isVariationPoint) return { method: 'counted', label: 'Counts the options that pass' };
  if (isExtensionOption) return { method: 'extension', label: "By the extension's tests" };
  const interaction = requirement.interaction;
  if (interaction === 'INTERNAL') {
    return { method: 'auditable', label: 'Audited against evidence' };
  }
  if (BOUNDARY[interaction]) {
    return { method: 'observable', label: `Tested at the ${BOUNDARY[interaction]} boundary` };
  }
  if (interaction) return { method: 'unknown', label: `Unknown interaction ${interaction}` };
  if (requirement.observability) return { method: 'legacy', label: undefined };
  return { method: 'unclassified', label: 'Unclassified' };
}

export function observabilityWarning(requirement, verification, sourceName) {
  if (!requirement.observability || verification.method === 'legacy') return undefined;
  const derived = { observable: 'OBSERVABLE', auditable: 'AUDITABLE' }[verification.method];
  if (derived && derived !== requirement.observability) {
    return `${sourceName}: observability ${requirement.observability} disagrees with interaction ${requirement.interaction}, which is verified as ${derived}; correct the interaction`;
  }
  return `${sourceName}: observability is no longer read in a Building Block specification; the verification method follows from interaction`;
}

function yamlText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function terminologyEntries(data) {
  const list = Array.isArray(data) ? data : data?.terms ?? data?.entries ?? data?.terminology;
  if (!Array.isArray(list)) return undefined;
  return list.map((item) => {
    const entry = item?.entry ?? item ?? {};
    return {
      term: yamlText(entry.term ?? entry.designation),
      abbreviation: yamlText(entry.abbreviation),
      definition: yamlText(entry.definition ?? entry.description),
      source: yamlText(entry.source ?? entry.designated_at),
      origin: yamlText(entry.origin),
      notes: asList(entry.notes ?? entry.note).map(yamlText).filter(Boolean),
      related: asList(entry.related).map(yamlText).filter(Boolean),
    };
  });
}

function referenceEntries(data) {
  const list = Array.isArray(data) ? data : data?.references;
  if (!Array.isArray(list)) return undefined;
  return list.map((item) => ({
    title: yamlText(item?.title ?? item?.name),
    url: yamlText(item?.url ?? item?.link),
    date: yamlText(item?.date),
    abstract: yamlText(item?.abstract ?? item?.description),
  }));
}

function markdownLinkText(value) {
  return value.replace(/([\\[\]])/g, '\\$1');
}

// Renders terminology.yml and references.yml as Markdown, so that they go through
// the same heading, anchor and link handling as every other page. Any other YAML
// page is shown verbatim, so that nothing it says is lost or reinterpreted.
export function yamlPage(sourceName, text) {
  const base = path.posix.basename(sourceName).replace(/\.ya?ml$/, '');
  const data = YAML.parse(text);
  if (base === 'terminology') {
    const entries = terminologyEntries(data);
    if (entries) {
      const body = entries
        .filter((entry) => entry.term)
        .map((entry) => {
          const heading = entry.abbreviation ? `${entry.term} (${entry.abbreviation})` : entry.term;
          const lines = [`## ${heading}`, '', entry.definition || '*No definition.*'];
          for (const note of entry.notes) lines.push('', `*Note:* ${note}`);
          const facts = [
            entry.source ? `Source: ${entry.source}` : '',
            entry.origin ? `Origin: ${entry.origin}` : '',
            entry.related.length ? `Related: ${entry.related.join(', ')}` : '',
          ].filter(Boolean);
          if (facts.length) lines.push('', `<p class="term-source">${facts.map((fact) => fact.replaceAll('&', '&amp;').replaceAll('<', '&lt;')).join(' · ')}</p>`);
          return lines.join('\n');
        })
        .join('\n\n');
      return { title: 'Terminology', markdown: `${body}\n` };
    }
  }
  if (base === 'references') {
    const entries = referenceEntries(data);
    if (entries) {
      const body = entries
        .filter((entry) => entry.title || entry.url)
        .map((entry) => {
          const title = markdownLinkText(entry.title || entry.url);
          const link = entry.url ? `[${title}](<${entry.url}>)` : title;
          const lines = [`- ${link}${entry.date ? ` (${entry.date})` : ''}`];
          if (entry.abstract) lines.push(`\n  ${entry.abstract.replaceAll('\n', ' ')}`);
          return lines.join('\n');
        })
        .join('\n');
      return { title: 'References', markdown: `${body}\n` };
    }
  }
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  return { title: base, markdown: `${fence}yaml\n${text.replace(/\n$/, '')}\n${fence}\n` };
}
