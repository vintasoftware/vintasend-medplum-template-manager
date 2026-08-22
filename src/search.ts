/**
 * Turning a `ManagedTemplateFilter` into FHIR search parameters.
 *
 * This used to be a *narrowing*: whatever FHIR could not express was finished in memory against
 * the whole store. That made every filter work and every read a scan, and it made
 * `getFilterCapabilities()` claim support this backend does not really have — a caller could not
 * tell an indexed query from a full table scan, and the scan silently became the cost of a
 * listing.
 *
 * It is now a **complete translation**. Everything this module emits, FHIR answers; everything it
 * cannot express is declared `false` in `getFilterCapabilities()` so callers drop it before it
 * gets here. A filter that arrives anyway is a caller ignoring the capability report, and it
 * throws rather than being quietly approximated.
 *
 * FHIR search is an AND of parameters: repeating a parameter ANDs, comma-separating its values
 * ORs *within* that parameter. There is no general OR and no general negation, which is why
 * `logical.or` and `logical.not` are declared unsupported.
 *
 * Two filters that would otherwise need more than a parameter are answered by **denormalization**:
 * the answer is computed at write time and stored on the row, so the read is a token match.
 * `isAbstract` is derived from the template source, and `mostRecentActiveVersion` from the key's
 * other versions. The seam already asks every backend to do the first; the second follows the
 * same pattern.
 */

import {
  isFieldFilter,
  isStringFilterLookup,
  type ManagedTemplateFilter,
  type ManagedTemplateFilterFields,
  ManagedTemplateInvalidFilterError,
  type ManagedTemplateOrderBy,
  normalizeSlugs,
  type StringFieldFilter,
} from 'vintasend-managed-templates';

import {
  IDENTIFIER_SYSTEM,
  RESOURCE_KIND,
  RESOURCE_KIND_SYSTEM,
  TEMPLATE_TAG_SYSTEM,
} from './constants.js';

/** A FHIR search as Medplum's `searchResources` takes it: repeated names are ANDed. */
export type SearchTuples = string[][];

/**
 * Escape a value so it survives a search parameter.
 *
 * `,` separates OR alternatives, `|` separates a token's system from its code, and `$` introduces
 * a composite — so a template key or tag slug containing one would otherwise be read as syntax.
 */
export function escapeSearchValue(value: string): string {
  return value.replace(/[\\,|$]/g, (character) => `\\${character}`);
}

function token(system: string, value: string): string {
  return `${system}|${escapeSearchValue(value)}`;
}

/** The parameter every read starts from: only the resources this backend owns. */
export function templateKindTuple(): string[] {
  return ['_tag', token(RESOURCE_KIND_SYSTEM, RESOURCE_KIND.template)];
}

export function tagKindTuple(): string[] {
  return ['_tag', token(RESOURCE_KIND_SYSTEM, RESOURCE_KIND.tag)];
}

/**
 * Which FHIR search parameter each orderable field sorts by, or `null` when none does.
 *
 * The two absences are load-bearing, and both were established by running the sorts rather than
 * by reading the spec:
 *
 * **`version`** is `MessageDefinition.version`, a *string* in FHIR, so `_sort=version` compares it
 * lexicographically. That is answerable anyway: the version is written left-padded with zeros, so
 * the lexicographic order *is* the numeric one. See `formatFhirVersion`.
 *
 * **`status`** is the one that stays out, and padding cannot rescue it. The managed status lives
 * in an identifier, and token parameters have no sort order; the only sortable status field is
 * FHIR's own `MessageDefinition.status`, into which `inactive` and `archived` both map as
 * `retired`. A sort that cannot tell two of the four statuses apart is worse than no sort.
 */
const SORT_PARAMETER: Record<ManagedTemplateOrderBy['field'], string | null> = {
  // `MessageDefinition.name` holds the template key; `title` holds its human name.
  key: 'name',
  name: 'title',
  createdAt: 'date',
  updatedAt: '_lastUpdated',
  version: 'version',
  status: null,
};

/** Whether this backend can order by `field` — the source of its `orderBy.*` declarations. */
export function canSortBy(field: ManagedTemplateOrderBy['field']): boolean {
  return SORT_PARAMETER[field] !== null;
}

/** The `_sort` tuple for an order, or nothing when no order was asked for. */
export function deriveSortTuples(orderBy: ManagedTemplateOrderBy | undefined): SearchTuples {
  if (orderBy === undefined) {
    return [];
  }
  const parameter = SORT_PARAMETER[orderBy.field];
  if (parameter === null) {
    throw new ManagedTemplateInvalidFilterError(
      `This backend cannot order by '${orderBy.field}'. Read the capability report ` +
        `(orderBy.${orderBy.field} is false) and offer only the fields it lists.`,
    );
  }
  return [['_sort', orderBy.direction === 'desc' ? `-${parameter}` : parameter]];
}

/**
 * The search parameters that answer `filter` exactly.
 *
 * @throws ManagedTemplateInvalidFilterError if the filter uses something this backend declares it
 *   cannot do. That is a caller bug rather than a condition to recover from: the capability report
 *   named the limitation before the call was made.
 */
export function deriveSearchTuples(filter: ManagedTemplateFilter): SearchTuples {
  const tuples: SearchTuples = [templateKindTuple()];
  for (const fields of conjunctiveFieldFilters(filter)) {
    tuples.push(...fieldTuples(fields));
  }
  return tuples;
}

/**
 * The field filters every matching row must satisfy, flattened out of nested `and`s.
 *
 * `or` and `not` are refused rather than flattened: neither can become a parameter that must
 * hold, and both are declared unsupported.
 */
function conjunctiveFieldFilters(filter: ManagedTemplateFilter): ManagedTemplateFilterFields[] {
  if (isFieldFilter(filter)) {
    return [filter];
  }
  if ('and' in filter) {
    return filter.and.flatMap(conjunctiveFieldFilters);
  }
  if ('or' in filter) {
    throw new ManagedTemplateInvalidFilterError(
      'This backend cannot evaluate an `or` group (logical.or is false). FHIR search ANDs its ' +
        'parameters and has no general disjunction.',
    );
  }
  throw new ManagedTemplateInvalidFilterError(
    'This backend cannot evaluate a `not` group (logical.not is false). FHIR search has no ' +
      'general negation.',
  );
}

/**
 * A string filter as a FHIR string-search parameter.
 *
 * FHIR gives three string matches and fixes the case sensitivity of each: the bare parameter is
 * case-insensitive *starts-with*, `:contains` is case-insensitive substring, and `:exact` is
 * case-sensitive equality. There is no ends-with at all.
 *
 * The capability vocabulary has one global `stringLookups.caseSensitive` key rather than one per
 * lookup, so it cannot express "case-sensitive equality yes, case-sensitive substring no". That
 * single combination therefore throws instead of being declared — approximating it with a
 * case-insensitive search would return rows the caller excluded, which is the silent wrongness
 * this module exists to remove.
 */
function stringTuple(parameter: string, filter: StringFieldFilter): string[] {
  if (!isStringFilterLookup(filter)) {
    // A bare string means exact and case-sensitive.
    return [`${parameter}:exact`, escapeSearchValue(filter)];
  }

  const caseSensitive = filter.caseSensitive !== false;
  switch (filter.lookup) {
    case 'exact':
      if (!caseSensitive) {
        throw new ManagedTemplateInvalidFilterError(
          `A case-insensitive 'exact' match on '${parameter}' is not something FHIR search ` +
            'offers: `:exact` is case-sensitive and every other match is a prefix or substring.',
        );
      }
      return [`${parameter}:exact`, escapeSearchValue(filter.value)];
    case 'startsWith':
      if (caseSensitive) {
        throw unsupportedCaseSensitivity('startsWith', parameter);
      }
      return [parameter, escapeSearchValue(filter.value)];
    case 'includes':
      if (caseSensitive) {
        throw unsupportedCaseSensitivity('includes', parameter);
      }
      return [`${parameter}:contains`, escapeSearchValue(filter.value)];
    default:
      throw new ManagedTemplateInvalidFilterError(
        `FHIR search has no '${filter.lookup}' match (stringLookups.${filter.lookup} is false).`,
      );
  }
}

function unsupportedCaseSensitivity(lookup: string, parameter: string): Error {
  return new ManagedTemplateInvalidFilterError(
    `A case-sensitive '${lookup}' match on '${parameter}' is not something FHIR search offers — ` +
      'its prefix and substring matches are case-insensitive. Drop `caseSensitive: true`, or ' +
      "use `lookup: 'exact'`, which FHIR does answer case-sensitively.",
  );
}

/** A token-backed field: the identifier carries the value verbatim, so only exact matching. */
function identifierTuple(system: string, field: string, filter: StringFieldFilter): string[] {
  if (!isStringFilterLookup(filter)) {
    return ['identifier', token(system, filter)];
  }
  if (filter.lookup !== 'exact') {
    throw new ManagedTemplateInvalidFilterError(
      `'${field}' is stored as a FHIR identifier, which only matches exactly, so ` +
        `'${filter.lookup}' cannot be answered against it.`,
    );
  }
  if (filter.caseSensitive === false) {
    throw new ManagedTemplateInvalidFilterError(
      `'${field}' is stored as a FHIR identifier, and token matching is case-sensitive.`,
    );
  }
  return ['identifier', token(system, filter.value)];
}

function fieldTuples(fields: ManagedTemplateFilterFields): SearchTuples {
  const tuples: SearchTuples = [];

  if (fields.key !== undefined) {
    tuples.push(identifierTuple(IDENTIFIER_SYSTEM.key, 'key', fields.key));
  }

  if (fields.templateManagedBackend !== undefined) {
    tuples.push(
      identifierTuple(
        IDENTIFIER_SYSTEM.backend,
        'templateManagedBackend',
        fields.templateManagedBackend,
      ),
    );
  }

  // `name` and `description` are FHIR strings rather than identifiers, so they take the string
  // matches: `title` holds the human name, `name` holds the key.
  if (fields.name !== undefined) {
    tuples.push(stringTuple('title', fields.name));
  }

  if (fields.description !== undefined) {
    tuples.push(stringTuple('description', fields.description));
  }

  if (fields.status !== undefined) {
    const statuses = statusValues(fields.status);
    if (statuses.length > 0) {
      tuples.push([
        'identifier',
        statuses.map((status) => token(IDENTIFIER_SYSTEM.status, status)).join(','),
      ]);
    }
  }

  if (fields.isAbstract !== undefined) {
    tuples.push(['identifier', token(IDENTIFIER_SYSTEM.abstract, String(fields.isAbstract))]);
  }

  if (fields.version !== undefined) {
    throw new ManagedTemplateInvalidFilterError(
      'This backend cannot filter by version (fields.version is false). FHIR stores ' +
        '`MessageDefinition.version` as a string, so it has no numeric comparison to offer.',
    );
  }

  // A comparison against a key's other versions, answered as a token because the answer is
  // denormalized onto each row at write time. See `refreshCurrentVersion`.
  if (fields.mostRecentActiveVersion !== undefined) {
    tuples.push([
      'identifier',
      token(IDENTIFIER_SYSTEM.currentVersion, String(fields.mostRecentActiveVersion)),
    ]);
  }

  // Repeating `_tag` is AND, which is what "carries every one of these" means.
  for (const slug of normalizeSlugs(fields.includesAllTags ?? [])) {
    tuples.push(['_tag', token(TEMPLATE_TAG_SYSTEM, slug)]);
  }

  if (fields.includesAnyOfTags !== undefined) {
    const slugs = normalizeSlugs(fields.includesAnyOfTags);
    if (slugs.length === 0) {
      // An empty `includesAnyOfTags` matches nothing, and no parameter says "nothing". A tag
      // system code cannot contain a space, so this matches no row by construction.
      tuples.push(['_tag', token(TEMPLATE_TAG_SYSTEM, 'matches nothing')]);
    } else {
      tuples.push(['_tag', slugs.map((slug) => token(TEMPLATE_TAG_SYSTEM, slug)).join(',')]);
    }
  }

  if (fields.createdAtRange !== undefined) {
    const { from, to } = fields.createdAtRange;
    if (from !== undefined) {
      tuples.push(['date', `ge${from.toISOString()}`]);
    }
    if (to !== undefined) {
      tuples.push(['date', `le${to.toISOString()}`]);
    }
  }

  if (fields.updatedAtRange !== undefined) {
    const { from, to } = fields.updatedAtRange;
    if (from !== undefined) {
      tuples.push(['_lastUpdated', `ge${from.toISOString()}`]);
    }
    if (to !== undefined) {
      tuples.push(['_lastUpdated', `le${to.toISOString()}`]);
    }
  }

  return tuples;
}

function statusValues(filter: ManagedTemplateFilterFields['status']): string[] {
  if (filter === undefined) {
    return [];
  }
  if (typeof filter === 'string') {
    return [filter];
  }
  if (filter.lookup === 'in') {
    return filter.value;
  }
  return [filter.value];
}
