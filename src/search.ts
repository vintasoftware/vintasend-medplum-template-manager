/**
 * Turning as much of a `ManagedTemplateFilter` as FHIR can express into search parameters.
 *
 * FHIR search is an AND of parameters, where repeating a parameter is another AND and
 * comma-separating its values is an OR *within* that parameter. There is no general OR and no
 * general negation, so a filter that uses either cannot be pushed down at all.
 *
 * What this module produces is therefore a **narrowing**, not a translation: every row the filter
 * would match is in the result, and rows it would not match may be too. The caller finishes the
 * job with `matchesTemplateFilter`, which is what makes an unpushable filter merely slower rather
 * than unsupported. The one rule every branch here obeys is that it may never exclude a row the
 * filter would have kept — so anything not clearly narrowable contributes nothing.
 */

import {
  isFieldFilter,
  isStringFilterLookup,
  type ManagedTemplateFilter,
  type ManagedTemplateFilterFields,
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

/** Whether a string filter is an exact, case-sensitive match — the only kind a token can answer. */
function exactValue(filter: StringFieldFilter): string | null {
  if (!isStringFilterLookup(filter)) {
    return filter;
  }
  if (filter.lookup === 'exact' && filter.caseSensitive !== false) {
    return filter.value;
  }
  return null;
}

/**
 * Search parameters that narrow towards `filter` without ever excluding a row it would keep.
 *
 * Only a top-level field filter, or a top-level `and` of them, contributes: inside an `or` a
 * condition is not required of every row, and inside a `not` it is required to be false, so
 * neither can be turned into a parameter that must hold. A filter built out of those simply
 * narrows to "every template", and the in-memory pass does the rest.
 */
export function deriveSearchTuples(filter: ManagedTemplateFilter): SearchTuples {
  const tuples: SearchTuples = [templateKindTuple()];
  for (const fields of conjunctiveFieldFilters(filter)) {
    tuples.push(...fieldTuples(fields));
  }
  return tuples;
}

/** The field filters that every matching row must satisfy, flattened out of nested `and`s. */
function conjunctiveFieldFilters(filter: ManagedTemplateFilter): ManagedTemplateFilterFields[] {
  if (isFieldFilter(filter)) {
    return [filter];
  }
  if ('and' in filter) {
    return filter.and.flatMap(conjunctiveFieldFilters);
  }
  return [];
}

function fieldTuples(fields: ManagedTemplateFilterFields): SearchTuples {
  const tuples: SearchTuples = [];

  if (fields.key !== undefined) {
    const value = exactValue(fields.key);
    if (value !== null) {
      tuples.push(['identifier', token(IDENTIFIER_SYSTEM.key, value)]);
    }
  }

  if (fields.templateManagedBackend !== undefined) {
    const value = exactValue(fields.templateManagedBackend);
    if (value !== null) {
      tuples.push(['identifier', token(IDENTIFIER_SYSTEM.backend, value)]);
    }
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

  // Only `true` narrows. Its complement is "every row that is *not* its key's current version",
  // which includes retired rows of every status — so there is nothing to exclude.
  if (fields.mostRecentActiveVersion === true) {
    tuples.push([
      'identifier',
      [token(IDENTIFIER_SYSTEM.status, 'active'), token(IDENTIFIER_SYSTEM.status, 'draft')].join(
        ',',
      ),
    ]);
  }

  // Repeating `_tag` is AND, which is what "carries every one of these" means.
  for (const slug of normalizeSlugs(fields.includesAllTags ?? [])) {
    tuples.push(['_tag', token(TEMPLATE_TAG_SYSTEM, slug)]);
  }

  if (fields.includesAnyOfTags !== undefined) {
    const slugs = normalizeSlugs(fields.includesAnyOfTags);
    // An empty `includesAnyOfTags` matches nothing, and no parameter expresses that — so it is
    // left to the in-memory pass rather than narrowed to everything and quietly widened.
    if (slugs.length > 0) {
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
