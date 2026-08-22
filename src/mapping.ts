/**
 * Turning managed templates into FHIR resources and back.
 *
 * A template version becomes one `MessageDefinition`: FHIR's canonical resource for "the
 * definition of a message that can be sent", versioned by `url` + `version`, which is exactly the
 * shape a managed template already has. A tag becomes a `Basic` — FHIR's honest escape hatch for
 * a concept it does not model — and a status change becomes a `Provenance`, which is what FHIR
 * calls an audit record.
 *
 * Everything that has a natural FHIR field gets one, so these resources read sensibly to anything
 * that is not this package. What has no home — the three template sources, a tag's text — goes in
 * an extension.
 */

import type {
  Basic,
  Extension,
  Identifier,
  MessageDefinition,
  Provenance,
} from '@medplum/fhirtypes';
import {
  isAbstract,
  type ManagedTemplate,
  type ManagedTemplateStatus,
  type ManagedTemplateStatusHistory,
  type ManagedTemplateTag,
  type ManagedTemplateTagStatus,
} from 'vintasend-managed-templates';

import {
  EXTENSION_URL,
  IDENTIFIER_SYSTEM,
  RESOURCE_KIND,
  RESOURCE_KIND_SYSTEM,
  TEMPLATE_EVENT_URI,
  TEMPLATE_TAG_SYSTEM,
  VERSION_SORT_WIDTH,
} from './constants.js';

/**
 * How a managed status maps onto `MessageDefinition.status`, which FHIR restricts to four values.
 *
 * `inactive` and `archived` both land on `retired` because FHIR has no way to tell "retired, may
 * come back" from "retired for good". The managed status is therefore *not* read back from this
 * field — it is read from the status identifier, which keeps all four. This field exists so a
 * FHIR client that knows nothing about VintaSend still sees a sensible publication status.
 */
const FHIR_STATUS: Record<ManagedTemplateStatus, MessageDefinition['status']> = {
  draft: 'draft',
  active: 'active',
  inactive: 'retired',
  archived: 'retired',
};

export type TemplateSources = {
  bodyTemplate: string;
  subjectTemplate: string | null;
  preheaderTemplate: string | null;
};

export type TemplateResourceInput = TemplateSources & {
  key: string;
  version: number;
  name: string;
  description: string;
  templateManagedBackend: string;
  status: ManagedTemplateStatus;
  tenant: string | null;
  createdAt: Date;
  tags: ManagedTemplateTag[];
};

function stringExtension(url: string, value: string | null | undefined): Extension[] {
  return value === null || value === undefined ? [] : [{ url, valueString: value }];
}

function readStringExtension(extensions: Extension[] | undefined, url: string): string | undefined {
  return extensions?.find((extension) => extension.url === url)?.valueString;
}

function identifier(system: string, value: string): Identifier {
  return { system, value };
}

function readIdentifier(identifiers: Identifier[] | undefined, system: string): string | undefined {
  return identifiers?.find((entry) => entry.system === system)?.value;
}

/**
 * Derive `isAbstract` from the sources being stored.
 *
 * A source whose composition tags are malformed has no answer, so it is stored as `false` rather
 * than failing the write: the flag is a search convenience, a template nobody can parse cannot be
 * extended either, and a write is the wrong place to report a syntax error — `compose` reports it
 * in full where it actually matters.
 */
export function deriveIsAbstract(sources: TemplateSources): boolean {
  try {
    return isAbstract(sources);
  } catch {
    return false;
  }
}

/**
 * The version as FHIR should store it: left-padded so a lexicographic sort is a numeric one.
 *
 * Reading goes through `Number.parseInt`, which ignores the padding, so the managed template a
 * caller sees is unchanged.
 *
 * @throws RangeError if the version will not fit, which would silently sort wrong.
 */
export function formatFhirVersion(version: number): string {
  const digits = String(version);
  if (digits.length > VERSION_SORT_WIDTH) {
    throw new RangeError(
      `Version ${version} needs more than ${VERSION_SORT_WIDTH} digits, which would break the ` +
        'lexicographic ordering `_sort=version` relies on.',
    );
  }
  return digits.padStart(VERSION_SORT_WIDTH, '0');
}

export function buildTemplateResource(
  input: TemplateResourceInput,
  urlPrefix: string,
): MessageDefinition {
  const abstract = deriveIsAbstract(input);

  return {
    resourceType: 'MessageDefinition',
    url: `${urlPrefix}${input.key}`,
    version: formatFhirVersion(input.version),
    // Computer-friendly name, which for a managed template is its key.
    name: input.key,
    title: input.name,
    description: input.description,
    // The backend that manages this template, in the field FHIR keeps for "who publishes this".
    publisher: input.templateManagedBackend,
    status: FHIR_STATUS[input.status],
    date: input.createdAt.toISOString(),
    eventUri: TEMPLATE_EVENT_URI,
    identifier: [
      identifier(IDENTIFIER_SYSTEM.key, input.key),
      identifier(IDENTIFIER_SYSTEM.status, input.status),
      identifier(IDENTIFIER_SYSTEM.backend, input.templateManagedBackend),
      identifier(IDENTIFIER_SYSTEM.abstract, String(abstract)),
      // Always false on a fresh resource. `refreshCurrentVersion` promotes the right row once the
      // write has landed, so a new version never briefly shares "current" with the one it
      // supersedes — during that window the listing is one version stale rather than doubled.
      identifier(IDENTIFIER_SYSTEM.currentVersion, 'false'),
      ...(input.tenant === null ? [] : [identifier(IDENTIFIER_SYSTEM.tenant, input.tenant)]),
    ],
    meta: {
      tag: [
        { system: RESOURCE_KIND_SYSTEM, code: RESOURCE_KIND.template },
        ...input.tags.map((tag) => ({
          system: TEMPLATE_TAG_SYSTEM,
          code: tag.slug,
          display: tag.text,
        })),
      ],
    },
    extension: [
      ...stringExtension(EXTENSION_URL.bodyTemplate, input.bodyTemplate),
      ...stringExtension(EXTENSION_URL.subjectTemplate, input.subjectTemplate),
      ...stringExtension(EXTENSION_URL.preheaderTemplate, input.preheaderTemplate),
      ...stringExtension(EXTENSION_URL.tenant, input.tenant),
    ],
  };
}

/**
 * Read a `MessageDefinition` back as a managed template.
 *
 * @param tagsBySlug the tag records behind `meta.tag`. A template's tags carry a status and
 *   timestamps that `meta.tag` has no room for, so the records are looked up rather than
 *   reconstructed; a slug with no record left behind it degrades to an active tag named by its
 *   slug rather than dropping the label off the template.
 */
export function toManagedTemplate(
  resource: MessageDefinition,
  tagsBySlug: Map<string, ManagedTemplateTag>,
): ManagedTemplate {
  const version = Number.parseInt(resource.version ?? '1', 10);
  const createdAt = resource.date === undefined ? new Date(0) : new Date(resource.date);
  const updatedAt =
    resource.meta?.lastUpdated === undefined ? createdAt : new Date(resource.meta.lastUpdated);

  return {
    id: resource.id ?? '',
    key: readIdentifier(resource.identifier, IDENTIFIER_SYSTEM.key) ?? resource.name ?? '',
    version: Number.isNaN(version) ? 1 : version,
    name: resource.title ?? '',
    description: resource.description ?? '',
    templateManagedBackend:
      readIdentifier(resource.identifier, IDENTIFIER_SYSTEM.backend) ?? resource.publisher ?? '',
    bodyTemplate: readStringExtension(resource.extension, EXTENSION_URL.bodyTemplate) ?? '',
    subjectTemplate: readStringExtension(resource.extension, EXTENSION_URL.subjectTemplate) ?? null,
    preheaderTemplate:
      readStringExtension(resource.extension, EXTENSION_URL.preheaderTemplate) ?? null,
    status: readTemplateStatus(resource),
    tenant: readStringExtension(resource.extension, EXTENSION_URL.tenant) ?? null,
    createdAt,
    updatedAt,
    tags: readTemplateTagSlugs(resource).map(
      (slug) => tagsBySlug.get(slug) ?? placeholderTag(slug),
    ),
    isAbstract: readIdentifier(resource.identifier, IDENTIFIER_SYSTEM.abstract) === 'true',
  };
}

/**
 * The managed status, read from the identifier rather than from `MessageDefinition.status`.
 *
 * FHIR's four publication statuses cannot represent `inactive` and `archived` separately, so the
 * identifier is the authority and the FHIR field is the summary. A resource written by something
 * other than this backend has no identifier, so its FHIR status is read as a best effort — and
 * `retired` resolves to `inactive`, the reversible of the two, because guessing wrong toward a
 * terminal status would take a template's future away.
 */
function readTemplateStatus(resource: MessageDefinition): ManagedTemplateStatus {
  const stored = readIdentifier(resource.identifier, IDENTIFIER_SYSTEM.status);
  if (stored === 'draft' || stored === 'active' || stored === 'inactive' || stored === 'archived') {
    return stored;
  }
  return resource.status === 'active'
    ? 'active'
    : resource.status === 'draft'
      ? 'draft'
      : 'inactive';
}

export function readTemplateTagSlugs(resource: MessageDefinition): string[] {
  return (resource.meta?.tag ?? [])
    .filter((coding) => coding.system === TEMPLATE_TAG_SYSTEM)
    .map((coding) => coding.code)
    .filter((code): code is string => typeof code === 'string');
}

function placeholderTag(slug: string): ManagedTemplateTag {
  return {
    id: slug,
    text: slug,
    slug,
    status: 'active',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    tenant: null,
  };
}

/** Replace the template tags on a resource, leaving every other coding in `meta.tag` alone. */
export function withTemplateTags(
  resource: MessageDefinition,
  tags: ManagedTemplateTag[],
): MessageDefinition {
  const others = (resource.meta?.tag ?? []).filter(
    (coding) => coding.system !== TEMPLATE_TAG_SYSTEM,
  );
  return {
    ...resource,
    meta: {
      ...resource.meta,
      tag: [
        ...others,
        ...tags.map((tag) => ({ system: TEMPLATE_TAG_SYSTEM, code: tag.slug, display: tag.text })),
      ],
    },
  };
}

/** Move a resource to a managed status, keeping the FHIR summary field in step. */
/**
 * The resource with its current-version flag set, or the same object when it already agrees.
 *
 * Returning the input unchanged is what lets `refreshCurrentVersion` write only the rows that
 * actually move.
 */
export function withCurrentVersionFlag(
  resource: MessageDefinition,
  isCurrent: boolean,
): MessageDefinition {
  if (readCurrentVersionFlag(resource) === isCurrent) {
    return resource;
  }
  const identifiers = (resource.identifier ?? []).filter(
    (entry) => entry.system !== IDENTIFIER_SYSTEM.currentVersion,
  );
  return {
    ...resource,
    identifier: [...identifiers, identifier(IDENTIFIER_SYSTEM.currentVersion, String(isCurrent))],
  };
}

/** A resource written before this flag existed reads as not current, which a refresh corrects. */
export function readCurrentVersionFlag(resource: MessageDefinition): boolean {
  return readIdentifier(resource.identifier, IDENTIFIER_SYSTEM.currentVersion) === 'true';
}

export function withTemplateStatus(
  resource: MessageDefinition,
  status: ManagedTemplateStatus,
): MessageDefinition {
  const identifiers = (resource.identifier ?? []).filter(
    (entry) => entry.system !== IDENTIFIER_SYSTEM.status,
  );
  return {
    ...resource,
    status: FHIR_STATUS[status],
    identifier: [...identifiers, identifier(IDENTIFIER_SYSTEM.status, status)],
  };
}

// ---------------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------------

export function buildTagResource(input: {
  text: string;
  slug: string;
  status: ManagedTemplateTagStatus;
  tenant: string | null;
  createdAt: Date;
}): Basic {
  return {
    resourceType: 'Basic',
    code: {
      coding: [{ system: RESOURCE_KIND_SYSTEM, code: RESOURCE_KIND.tag }],
      text: input.text,
    },
    identifier: [
      identifier(IDENTIFIER_SYSTEM.tagSlug, input.slug),
      ...(input.tenant === null ? [] : [identifier(IDENTIFIER_SYSTEM.tenant, input.tenant)]),
    ],
    meta: { tag: [{ system: RESOURCE_KIND_SYSTEM, code: RESOURCE_KIND.tag }] },
    extension: [
      ...stringExtension(EXTENSION_URL.tagText, input.text),
      ...stringExtension(EXTENSION_URL.tagStatus, input.status),
      ...stringExtension(EXTENSION_URL.tenant, input.tenant),
      { url: EXTENSION_URL.createdAt, valueDateTime: input.createdAt.toISOString() },
    ],
  };
}

export function toManagedTag(resource: Basic): ManagedTemplateTag {
  const createdAtValue = resource.extension?.find(
    (extension) => extension.url === EXTENSION_URL.createdAt,
  )?.valueDateTime;
  const createdAt = createdAtValue === undefined ? new Date(0) : new Date(createdAtValue);
  const status = readStringExtension(resource.extension, EXTENSION_URL.tagStatus);

  return {
    id: resource.id ?? '',
    text:
      readStringExtension(resource.extension, EXTENSION_URL.tagText) ?? resource.code?.text ?? '',
    slug: readIdentifier(resource.identifier, IDENTIFIER_SYSTEM.tagSlug) ?? '',
    status: status === 'archived' ? 'archived' : 'active',
    createdAt,
    updatedAt:
      resource.meta?.lastUpdated === undefined ? createdAt : new Date(resource.meta.lastUpdated),
    tenant: readStringExtension(resource.extension, EXTENSION_URL.tenant) ?? null,
  };
}

/** Rewrite a tag resource's text and slug, which is what a rename is. */
export function withTagText(resource: Basic, text: string, slug: string): Basic {
  const identifiers = (resource.identifier ?? []).filter(
    (entry) => entry.system !== IDENTIFIER_SYSTEM.tagSlug,
  );
  return {
    ...resource,
    code: { ...resource.code, text },
    identifier: [...identifiers, identifier(IDENTIFIER_SYSTEM.tagSlug, slug)],
    extension: [
      ...(resource.extension ?? []).filter((extension) => extension.url !== EXTENSION_URL.tagText),
      { url: EXTENSION_URL.tagText, valueString: text },
    ],
  };
}

export function withTagStatus(resource: Basic, status: ManagedTemplateTagStatus): Basic {
  return {
    ...resource,
    extension: [
      ...(resource.extension ?? []).filter(
        (extension) => extension.url !== EXTENSION_URL.tagStatus,
      ),
      { url: EXTENSION_URL.tagStatus, valueString: status },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Status history
// ---------------------------------------------------------------------------------------------

export function buildStatusChangeResource(input: {
  templateResourceId: string;
  status: ManagedTemplateStatus;
  changedBy: string | null;
  recordedAt: Date;
}): Provenance {
  return {
    resourceType: 'Provenance',
    target: [{ reference: `MessageDefinition/${input.templateResourceId}` }],
    recorded: input.recordedAt.toISOString(),
    activity: {
      coding: [{ system: IDENTIFIER_SYSTEM.status, code: input.status }],
      text: input.status,
    },
    // FHIR requires an agent with a `who`. An unattributed change is the norm here — the service
    // never demands attribution — so `who.display` carries the name when there is one and says
    // plainly that there is not when there is not, rather than inventing a reference.
    agent: [
      {
        who: { display: input.changedBy ?? 'unattributed' },
      },
    ],
    meta: { tag: [{ system: RESOURCE_KIND_SYSTEM, code: RESOURCE_KIND.statusChange }] },
    extension: [
      ...stringExtension(EXTENSION_URL.statusChangeStatus, input.status),
      ...stringExtension(EXTENSION_URL.tenant, null),
    ],
  };
}

export function toStatusHistory(
  resource: Provenance,
  template: { key: string; version: number; tenant: string | null },
): ManagedTemplateStatusHistory {
  const recorded = resource.recorded === undefined ? new Date(0) : new Date(resource.recorded);
  const changedBy = resource.agent?.[0]?.who?.display;

  return {
    templateKey: template.key,
    version: template.version,
    status: readStatusChangeStatus(resource),
    createdAt: recorded,
    changedBy: changedBy === undefined || changedBy === 'unattributed' ? null : changedBy,
    tenant: template.tenant,
  };
}

function readStatusChangeStatus(resource: Provenance): ManagedTemplateStatus {
  const code =
    readStringExtension(resource.extension, EXTENSION_URL.statusChangeStatus) ??
    resource.activity?.coding?.[0]?.code;
  if (code === 'draft' || code === 'active' || code === 'inactive' || code === 'archived') {
    return code;
  }
  return 'draft';
}

export function statusChangeTargetId(resource: Provenance): string | null {
  const reference = resource.target?.[0]?.reference;
  if (typeof reference !== 'string') {
    return null;
  }
  const [, id] = reference.split('/');
  return id ?? null;
}
