/**
 * The FHIR vocabulary this backend writes, in one place.
 *
 * Every value here is part of the stored data, not an implementation detail: change one and the
 * resources already in a Medplum project stop being found. They are exported so an operator can
 * write their own queries, a migration can rewrite them deliberately, and a test can assert on
 * them rather than on a string literal copied by hand.
 */

/** Marks the resources this backend owns, so a project shared with other data stays separable. */
export const RESOURCE_KIND_SYSTEM = 'http://vintasend.com/fhir/resource-kind';

export const RESOURCE_KIND = {
  template: 'vintasend-managed-template',
  tag: 'vintasend-managed-template-tag',
  statusChange: 'vintasend-managed-template-status-change',
} as const;

/**
 * Identifier systems.
 *
 * Fields a query has to narrow on are stored as identifiers rather than only in their natural
 * FHIR field, because `identifier` is a token search — exact, case-sensitive, repeatable for AND
 * and comma-separable for OR — and every FHIR server supports it the same way. The natural fields
 * are populated too, for anything reading these resources as ordinary FHIR.
 */
export const IDENTIFIER_SYSTEM = {
  key: 'http://vintasend.com/fhir/managed-template-key',
  status: 'http://vintasend.com/fhir/managed-template-status',
  backend: 'http://vintasend.com/fhir/managed-template-backend',
  abstract: 'http://vintasend.com/fhir/managed-template-abstract',
  /**
   * Whether this row is its key's most recent active version — denormalized so the filter is a
   * token match instead of a group-by FHIR does not have. Maintained on every write that can
   * change the answer; see `refreshCurrentVersion`.
   */
  currentVersion: 'http://vintasend.com/fhir/managed-template-current-version',
  tenant: 'http://vintasend.com/fhir/managed-template-tenant',
  tagSlug: 'http://vintasend.com/fhir/managed-template-tag-slug',
} as const;

/**
 * The coding system a template's tags live under in `meta.tag`.
 *
 * `_tag` is what makes tag filtering a server-side query: repeating the parameter is AND, which is
 * `includesAllTags`, and comma-separating values is OR, which is `includesAnyOfTags`.
 */
export const TEMPLATE_TAG_SYSTEM = 'http://vintasend.com/fhir/managed-template-tag';

/** Extension URLs carrying what no FHIR field has a home for. */
export const EXTENSION_URL = {
  bodyTemplate: 'http://vintasend.com/fhir/StructureDefinition/managed-template-body',
  subjectTemplate: 'http://vintasend.com/fhir/StructureDefinition/managed-template-subject',
  preheaderTemplate: 'http://vintasend.com/fhir/StructureDefinition/managed-template-preheader',
  tenant: 'http://vintasend.com/fhir/StructureDefinition/managed-template-tenant',
  tagText: 'http://vintasend.com/fhir/StructureDefinition/managed-template-tag-text',
  tagStatus: 'http://vintasend.com/fhir/StructureDefinition/managed-template-tag-status',
  createdAt: 'http://vintasend.com/fhir/StructureDefinition/managed-template-created-at',
  statusChangeStatus:
    'http://vintasend.com/fhir/StructureDefinition/managed-template-status-change-status',
} as const;

/**
 * `MessageDefinition.event[x]` is required by FHIR and has no managed-template meaning, so every
 * template carries the same marker rather than an invented per-template event.
 */
export const TEMPLATE_EVENT_URI = 'http://vintasend.com/fhir/event/notification-template';

/** Default prefix for the canonical `MessageDefinition.url`, which is `<prefix><key>`. */
export const DEFAULT_URL_PREFIX = 'urn:vintasend:managed-template:';

/**
 * How many resources one read will pull back before giving up.
 *
 * Filters this backend cannot push into a FHIR search are finished in memory, which means a scan.
 * A template store is a vocabulary rather than an event log — hundreds of rows, not millions — so
 * a bound this size is generous. It throws rather than truncating: a short page that looks
 * complete is the one failure mode a caller cannot detect.
 */
export const DEFAULT_MAX_SCAN = 5000;

/**
 * How many digits `MessageDefinition.version` is padded to.
 *
 * FHIR stores the version as a *string*, so `_sort=version` compares it lexicographically and puts
 * v10 before v2. Left-padding with zeros makes the lexicographic order the numeric one, which is
 * what lets this backend offer `orderBy.version` at all.
 *
 * Twelve digits is far past any real template history and keeps the padded value comfortably
 * inside a FHIR string. A version wider than this would sort wrong rather than fail, so
 * `formatFhirVersion` refuses it instead.
 */
export const VERSION_SORT_WIDTH = 12;

/** Medplum caps a single search page at 1000. */
export const SEARCH_PAGE_SIZE = 1000;
