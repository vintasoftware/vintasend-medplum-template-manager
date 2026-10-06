/**
 * A `BaseTemplateManagerBackend` that stores managed templates as FHIR resources in Medplum.
 *
 * Three resource types carry the whole seam:
 *
 * | Managed concept | FHIR resource |
 * |---|---|
 * | A template *version* | `MessageDefinition`, versioned by `url` + `version` |
 * | A tag | `Basic`, FHIR's escape hatch for a concept it does not model |
 * | A status change | `Provenance`, which is what FHIR calls an audit record |
 *
 * `MessageDefinition` is not a stretch: FHIR's own description of it is "the definition of a
 * message that can be sent", identified by a canonical URL and a version — which is a managed
 * template exactly. What it has no field for (three template sources, a tag's text) goes in an
 * extension; what a query has to narrow on additionally goes in an identifier, because
 * `identifier` is a token search and every FHIR server answers those the same way.
 *
 * ## Filtering and ordering
 *
 * Every read is a FHIR query. A filter is translated completely or refused — nothing is finished
 * in memory — and a page is chosen by the server with `_count` and `_offset` rather than by
 * reading the store and slicing.
 *
 * This backend used to work the other way: whatever FHIR could not express was evaluated in
 * memory over the whole store, which made every filter "supported" and every listing a scan.
 * `getFilterCapabilities` reported `{}` — no limitations — and a caller had no way to tell an
 * indexed query from a full read, or to choose differently.
 *
 * What FHIR search cannot express is now declared instead: no general OR, no general negation, no
 * numeric comparison on a version it stores as a string, and no ends-with. Callers drop those
 * filters — `ManagedTemplateService` does it for them.
 *
 * Two filters are answered by **denormalization** rather than by a parameter, because the answer
 * is computed at write time and stored on the row: `isAbstract`, which the seam asks every backend
 * to derive, and `mostRecentActiveVersion`, which compares a row against its key's other versions.
 * See `refreshCurrentVersion` for what maintaining the second costs.
 *
 * Ordering by version works the same way: FHIR stores `MessageDefinition.version` as a string, so
 * it is written zero-padded and `_sort=version` becomes numeric.
 *
 * Both are storage details of this package. A managed template's `version` is a `number`
 * everywhere outside it, and nothing in the seam knows either representation exists.
 *
 * `maxScan` still bounds the reads that are genuinely unbounded: `getAllTemplates`, the tag list,
 * and a version's status history. Paginated reads are no longer among them.
 */

import type { MedplumClient } from '@medplum/core';
import type { Basic, MessageDefinition, Provenance } from '@medplum/fhirtypes';
import type { BaseLogger } from 'vintasend';
import {
  assertTemplateVersionDeletable,
  type BaseTemplateManagerBackend,
  isMostRecentActiveVersion,
  MANAGED_TEMPLATE_ORDER_BY_FIELDS,
  type ManagedTemplate,
  type ManagedTemplateCreateInput,
  type ManagedTemplateFilter,
  type ManagedTemplateFilterCapabilities,
  ManagedTemplateInvalidTagError,
  ManagedTemplateNotFoundError,
  type ManagedTemplateOrderBy,
  type ManagedTemplateStatus,
  type ManagedTemplateStatusHistory,
  type ManagedTemplateTag,
  ManagedTemplateTagAlreadyExistsError,
  ManagedTemplateTagNotFoundError,
  type ManagedTemplateTagStatus,
  type ManagedTemplateUpdateInput,
  newestActiveVersion,
  nextAvailableSlug,
  noActiveVersion,
  normalizeTagText,
  orderByCapabilityKey,
  slugifyTag,
} from 'vintasend-managed-templates';

import {
  DEFAULT_MAX_SCAN,
  DEFAULT_URL_PREFIX,
  IDENTIFIER_SYSTEM,
  SEARCH_PAGE_SIZE,
} from './constants.js';
import {
  buildStatusChangeResource,
  buildTagResource,
  buildTemplateResource,
  deriveIsAbstract,
  readTemplateTagSlugs,
  statusChangeTargetId,
  toManagedTag,
  toManagedTemplate,
  toStatusHistory,
  withCurrentVersionFlag,
  withTagStatus,
  withTagText,
  withTemplateStatus,
  withTemplateTags,
} from './mapping.js';
import {
  canSortBy,
  deriveSearchTuples,
  deriveSortTuples,
  escapeSearchValue,
  type SearchTuples,
  tagKindTuple,
  templateKindTuple,
} from './search.js';

export type MedplumTemplateManagerBackendOptions = {
  /**
   * Prefix for the canonical `MessageDefinition.url`, which is `<prefix><key>`. Give a deployment
   * its own prefix when one Medplum project holds templates for more than one application.
   */
  urlPrefix?: string;
  /**
   * How many resources one read will pull back before throwing. See the note on
   * `DEFAULT_MAX_SCAN`.
   */
  maxScan?: number;
  /**
   * How many resources one search request asks for. Medplum caps this at 1000, which is the
   * default; lower it only for a server that struggles with pages that size.
   */
  pageSize?: number;
  /**
   * When true, `deleteTemplate` removes a version whatever its status. Off by default: only a
   * version that was never published — still `draft`, with nothing but `draft` in its status
   * history — can be deleted, and anything else throws `ManagedTemplateDeletionNotAllowedError`.
   * Retire a published version with `archive` instead. `ManagedTemplateService` checks the same
   * rule under its own option of this name, so a hard delete through the service needs both.
   *
   * The version's `Provenance` trail is kept either way.
   */
  allowDeletingPublishedVersions?: boolean;
};

export class MedplumTemplateManagerBackend implements BaseTemplateManagerBackend {
  private logger: BaseLogger | null = null;

  private readonly urlPrefix: string;

  private readonly maxScan: number;

  private readonly pageSize: number;

  private readonly allowDeletingPublishedVersions: boolean;

  constructor(
    private readonly medplum: MedplumClient,
    options: MedplumTemplateManagerBackendOptions = {},
  ) {
    this.urlPrefix = options.urlPrefix ?? DEFAULT_URL_PREFIX;
    this.maxScan = options.maxScan ?? DEFAULT_MAX_SCAN;
    this.pageSize = options.pageSize ?? SEARCH_PAGE_SIZE;
    this.allowDeletingPublishedVersions = options.allowDeletingPublishedVersions ?? false;
  }

  injectLogger(logger: BaseLogger): void {
    this.logger = logger;
  }

  /**
   * What FHIR search cannot answer, declared rather than faked.
   *
   * Everything listed here was previously "supported" by reading the whole store and finishing
   * the filter in memory. That made a listing a scan and made this report a lie: a caller could
   * not tell an indexed query from a full read, and could not choose differently if it wanted to.
   *
   * The `orderBy` entries are the other half. Every `orderBy.*` key defaults to false, so the
   * four this backend can genuinely serve have to be declared explicitly — and the two it cannot
   * are left at the default for reasons `SORT_PARAMETER` records: FHIR stores `version` as a
   * string, so sorting it puts v10 before v2, and the managed status lives in an identifier,
   * which has no sort order.
   */
  getFilterCapabilities(): ManagedTemplateFilterCapabilities {
    return {
      // FHIR search ANDs its parameters. There is no general disjunction and no general negation.
      'logical.or': false,
      'logical.not': false,
      'logical.notNested': false,
      // `MessageDefinition.version` is a FHIR string, so there is no numeric comparison for it.
      'fields.version': false,
      // FHIR string search offers starts-with, contains and exact. There is no ends-with.
      'stringLookups.endsWith': false,
      ...Object.fromEntries(
        MANAGED_TEMPLATE_ORDER_BY_FIELDS.filter(canSortBy).map((field) => [
          orderByCapabilityKey(field),
          true,
        ]),
      ),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------------------------

  async createTemplate(data: ManagedTemplateCreateInput): Promise<ManagedTemplate> {
    const tags = await this.getOrCreateTags(data.tags ?? [], data.tenant);
    const created = await this.medplum.createResource(
      buildTemplateResource(
        {
          key: data.key,
          version: 1,
          name: data.name,
          description: data.description,
          templateManagedBackend: data.templateManagedBackend,
          bodyTemplate: data.bodyTemplate,
          subjectTemplate: data.subjectTemplate,
          preheaderTemplate: data.preheaderTemplate,
          status: 'draft',
          tenant: data.tenant,
          createdAt: new Date(),
          tags,
        },
        this.urlPrefix,
      ),
    );
    await this.refreshCurrentVersion(data.key);
    return toManagedTemplate(created, indexBySlug(tags));
  }

  async getTemplate(templateKey: string, version: number | null = null): Promise<ManagedTemplate> {
    const resource = await this.requireResource(templateKey, version);
    return this.hydrate([resource]).then((templates) => templates[0] as ManagedTemplate);
  }

  /**
   * The newest `active` version — what an unpinned send renders.
   *
   * One search for the key's versions, compared by version number rather than by the string FHIR
   * stores it as, and tags hydrated only for the winner.
   */
  async getActiveTemplate(templateKey: string): Promise<ManagedTemplate> {
    const resources = await this.searchTemplateResources([
      templateKindTuple(),
      ['identifier', `${IDENTIFIER_SYSTEM.key}|${escapeSearchValue(templateKey)}`],
    ]);
    if (resources.length === 0) {
      throw new ManagedTemplateNotFoundError(describeMissing(templateKey, null));
    }

    const noTags = new Map<string, ManagedTemplateTag>();
    const active = newestActiveVersion(
      resources.map((resource) => toManagedTemplate(resource, noTags)),
    );
    const resource =
      active === undefined
        ? undefined
        : resources.find((candidate) => String(candidate.id) === String(active.id));
    if (resource === undefined) {
      throw noActiveVersion(templateKey);
    }
    return (await this.hydrate([resource]))[0] as ManagedTemplate;
  }

  /**
   * Insert the next version of a key, leaving the version it was copied from alone.
   *
   * A new resource, never an edit. A version that is already active keeps its content, its status
   * and its history while its successor is drafted, so notifications recorded against it go on
   * rendering exactly what they were sent with — which is the whole reason templates are versioned.
   *
   * FHIR has no transaction around a read-then-insert, so two concurrent updates can both read the
   * same latest version and both write `n + 1`. That is a duplicate version number rather than a
   * lost write: both resources exist, both are readable, and the later one wins every "latest"
   * resolution. A store that needs stricter serialization should put the writes behind its own
   * lock — the seam has no way to ask FHIR for one.
   */
  async updateTemplate(
    templateKey: string,
    data: ManagedTemplateUpdateInput,
  ): Promise<ManagedTemplate> {
    const previousResource = await this.requireResource(templateKey, null);
    const previous = (await this.hydrate([previousResource]))[0] as ManagedTemplate;

    // Resolved before the insert so an unusable tag text fails the whole update rather than
    // leaving a new version behind with the wrong labels.
    const tags =
      data.tags === undefined || data.tags === null
        ? previous.tags
        : await this.getOrCreateTags(data.tags, previous.tenant);

    const created = await this.medplum.createResource(
      buildTemplateResource(
        {
          key: previous.key,
          version: previous.version + 1,
          name: data.name || previous.name,
          description: data.description ?? previous.description,
          templateManagedBackend: previous.templateManagedBackend,
          bodyTemplate: data.bodyTemplate || previous.bodyTemplate,
          subjectTemplate: data.subjectTemplate ?? previous.subjectTemplate,
          preheaderTemplate: data.preheaderTemplate ?? previous.preheaderTemplate,
          // A copy nobody has reviewed should not inherit "published".
          status: 'draft',
          tenant: previous.tenant,
          createdAt: new Date(),
          tags,
        },
        this.urlPrefix,
      ),
    );
    await this.refreshCurrentVersion(previous.key);
    return toManagedTemplate(created, indexBySlug(tags));
  }

  /**
   * Delete one version that was never published. Its `Provenance` trail is never deleted.
   *
   * A version that was ever published is refused with `ManagedTemplateDeletionNotAllowedError`
   * unless `allowDeletingPublishedVersions` is on: a notification may be pinned to it, and its
   * `Provenance` resources are the record of who published it. Those stay in the store even when a
   * hard delete is allowed — they are FHIR's audit records and have to outlive what they describe.
   */
  async deleteTemplate(templateKey: string, version: number | null = null): Promise<void> {
    const resource = await this.requireResource(templateKey, version);
    const resourceId = resource.id as string;

    if (!this.allowDeletingPublishedVersions) {
      const template = (await this.hydrate([resource]))[0] as ManagedTemplate;
      const history = (await this.searchStatusChanges([resourceId])).map((change) =>
        toStatusHistory(change, template),
      );
      assertTemplateVersionDeletable(template, history);
    } else {
      // Opaque identifiers only: the operator switched the rule off, so say which resource went.
      this.logger?.warn(
        `[MedplumTemplateManager] deleting MessageDefinition/${resourceId} without checking ` +
          'whether it was published (allowDeletingPublishedVersions is on).',
      );
    }

    await this.medplum.deleteResource('MessageDefinition', resourceId);
    await this.refreshCurrentVersion(templateKey);
  }

  async createTemplateStatusUpdate(params: {
    templateKey: string;
    version: number;
    status: ManagedTemplateStatus;
    changedBy?: string | null;
  }): Promise<void> {
    const resource = await this.requireResource(params.templateKey, params.version);

    await this.medplum.updateResource(withTemplateStatus(resource, params.status));
    await this.medplum.createResource(
      buildStatusChangeResource({
        templateResourceId: resource.id as string,
        status: params.status,
        changedBy: params.changedBy ?? null,
        recordedAt: new Date(),
      }),
    );
    await this.refreshCurrentVersion(params.templateKey);
  }

  async getTemplateStatusHistory(
    templateKey: string,
    version: number | null = null,
  ): Promise<ManagedTemplateStatusHistory[]> {
    const resources = await this.searchTemplateResources([
      templateKindTuple(),
      ['identifier', `${IDENTIFIER_SYSTEM.key}|${escapeSearchValue(templateKey)}`],
    ]);
    if (resources.length === 0) {
      throw new ManagedTemplateNotFoundError(describeMissing(templateKey, null));
    }

    const templates = await this.hydrate(resources);
    const wanted = templates.filter((template) => version === null || template.version === version);
    if (wanted.length === 0) {
      throw new ManagedTemplateNotFoundError(describeMissing(templateKey, version));
    }

    const byResourceId = new Map(wanted.map((template) => [String(template.id), template]));
    const changes = await this.searchStatusChanges([...byResourceId.keys()]);

    return changes.flatMap((change) => {
      const targetId = statusChangeTargetId(change);
      const template = targetId === null ? undefined : byResourceId.get(targetId);
      return template === undefined ? [] : [toStatusHistory(change, template)];
    });
  }

  // -------------------------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------------------------

  /**
   * Resolve texts to tags, creating what is missing — one tag per distinct text, in order.
   *
   * An existing tag is returned as it stands: its text and status are left alone, so re-using an
   * archived tag does not quietly bring it back.
   */
  async getOrCreateTags(
    texts: string[],
    tenant: string | null = null,
  ): Promise<ManagedTemplateTag[]> {
    const resolved: ManagedTemplateTag[] = [];
    for (const text of texts) {
      const cleaned = this.cleanText(text);
      const slug = slugifyTag(cleaned);
      if (resolved.some((tag) => tag.slug === slug)) {
        continue;
      }
      const existing = await this.findTagResource(slug);
      resolved.push(
        existing === null ? await this.insertTag(cleaned, tenant) : toManagedTag(existing),
      );
    }
    return resolved;
  }

  async createTag(text: string, tenant: string | null = null): Promise<ManagedTemplateTag> {
    const cleaned = this.cleanText(text);
    const slug = slugifyTag(cleaned);
    if ((await this.findTagResource(slug)) !== null) {
      throw new ManagedTemplateTagAlreadyExistsError(`A tag with slug '${slug}' already exists.`);
    }
    return this.insertTag(cleaned, tenant);
  }

  async getTag(slug: string): Promise<ManagedTemplateTag> {
    return toManagedTag(await this.requireTagResource(slug));
  }

  async updateTag(slug: string, text: string): Promise<ManagedTemplateTag> {
    const resource = await this.requireTagResource(slug);
    const cleaned = this.cleanText(text);
    const nextSlug = await nextAvailableSlug(slugifyTag(cleaned), async (candidate) => {
      const taken = await this.findTagResource(candidate);
      return taken !== null && taken.id !== resource.id;
    });

    const updated = await this.medplum.updateResource(withTagText(resource, cleaned, nextSlug));
    const tag = toManagedTag(updated);
    await this.retagTemplates(slugifyTag(slug), tag);
    return tag;
  }

  async setTagStatus(slug: string, status: ManagedTemplateTagStatus): Promise<ManagedTemplateTag> {
    const resource = await this.requireTagResource(slug);
    return toManagedTag(await this.medplum.updateResource(withTagStatus(resource, status)));
  }

  /** Delete a tag and take the label off every template carrying it. */
  async deleteTag(slug: string): Promise<void> {
    const resource = await this.requireTagResource(slug);
    const normalized = slugifyTag(slug);

    for (const template of await this.searchTemplatesCarryingTag(normalized)) {
      const remaining = readTemplateTagSlugs(template).filter(
        (candidate) => candidate !== normalized,
      );
      await this.medplum.updateResource(
        withTemplateTags(template, await this.tagsForSlugs(remaining)),
      );
    }

    await this.medplum.deleteResource('Basic', resource.id as string);
  }

  async getTags(
    status: ManagedTemplateTagStatus[] | null = null,
    search: string | null = null,
    tenant: string | null = null,
  ): Promise<ManagedTemplateTag[]> {
    const term = search === null ? null : search.toLowerCase();
    return (await this.searchTagResources([tagKindTuple()]))
      .map(toManagedTag)
      .filter((tag) => status === null || status.includes(tag.status))
      .filter((tag) => tenant === null || tag.tenant === tenant)
      .filter(
        (tag) =>
          term === null ||
          tag.text.toLowerCase().includes(term) ||
          tag.slug.toLowerCase().includes(term),
      );
  }

  async getTemplateTags(
    templateKey: string,
    version: number | null = null,
  ): Promise<ManagedTemplateTag[]> {
    return (await this.getTemplate(templateKey, version)).tags;
  }

  async setTemplateTags(
    templateKey: string,
    tags: string[],
    version: number | null = null,
  ): Promise<ManagedTemplate> {
    const resource = await this.requireResource(templateKey, version);
    const tenant = (await this.hydrate([resource]))[0]?.tenant ?? null;
    const resolved = await this.getOrCreateTags(tags, tenant);

    const updated = await this.medplum.updateResource(withTemplateTags(resource, resolved));
    return toManagedTemplate(updated, indexBySlug(resolved));
  }

  // -------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------

  async getAllTemplates(): Promise<ManagedTemplate[]> {
    return this.hydrate(await this.searchTemplateResources([templateKindTuple()]));
  }

  async getTemplatesByStatus(status: ManagedTemplateStatus[]): Promise<ManagedTemplate[]> {
    if (status.length === 0) {
      return [];
    }
    return this.hydrate(
      await this.searchTemplateResources([
        templateKindTuple(),
        ['identifier', status.map((entry) => `${IDENTIFIER_SYSTEM.status}|${entry}`).join(',')],
      ]),
    );
  }

  async getFilteredTemplates(filters: ManagedTemplateFilter): Promise<ManagedTemplate[]> {
    return this.hydrate(await this.searchTemplateResources(deriveSearchTuples(filters)));
  }

  async getPaginatedTemplates(
    page: number,
    pageSize: number,
    orderBy?: ManagedTemplateOrderBy,
  ): Promise<ManagedTemplate[]> {
    return this.getPaginatedFilteredTemplates({}, page, pageSize, orderBy);
  }

  /**
   * One page, asked of FHIR as a page.
   *
   * The filter translates completely and the sort is a `_sort` parameter, so the server chooses
   * the page — `_count` and `_offset` rather than reading everything and slicing. Page 500 costs
   * what page 1 costs, and nothing here is bounded by `maxScan`.
   */
  async getPaginatedFilteredTemplates(
    filters: ManagedTemplateFilter,
    page: number,
    pageSize: number,
    orderBy?: ManagedTemplateOrderBy,
  ): Promise<ManagedTemplate[]> {
    const resources = (await this.medplum.searchResources('MessageDefinition', [
      ...deriveSearchTuples(filters),
      ...deriveSortTuples(orderBy),
      ['_count', String(pageSize)],
      ['_offset', String((page - 1) * pageSize)],
    ])) as MessageDefinition[];

    return this.hydrate(resources);
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  /**
   * Recompute which version of `templateKey` is current, and write the flag where it moved.
   *
   * This is the write-side cost of denormalizing `mostRecentActiveVersion`. FHIR has no group-by,
   * so the filter cannot be a query over a key's other versions — but it can be a token match
   * against an answer computed here, which is the same trade `isAbstract` already makes.
   *
   * Four writes can change the answer, and each one calls this afterwards:
   *
   * | Write | How the answer moves |
   * |---|---|
   * | `createTemplate` | a new key's only version becomes current |
   * | `updateTemplate` | the inserted draft supersedes the version it was copied from |
   * | `deleteTemplate` | deleting the current version promotes the next one down |
   * | `createTemplateStatusUpdate` | retiring the current version promotes another; reactivating an older one may take it back |
   *
   * The winner is decided by the library's own `isMostRecentActiveVersion` rather than by a rule
   * re-derived here, so the stored flag cannot drift from what the filter means.
   *
   * **The flips go in one transaction bundle**, so a listing never shows a key twice. The window
   * that remains is between the write that moved the answer and this call: during it the flag is
   * one write stale, which shows the *previous* current version rather than none or two. New
   * resources are built with the flag `false` for exactly that reason — a new version that
   * arrived already flagged would double the key instead.
   */
  private async refreshCurrentVersion(templateKey: string): Promise<void> {
    const resources = await this.searchTemplateResources([
      templateKindTuple(),
      ['identifier', `${IDENTIFIER_SYSTEM.key}|${escapeSearchValue(templateKey)}`],
    ]);
    if (resources.length === 0) {
      return;
    }

    // Mapped without hydrating tags: the answer turns on key, version and status alone, and a
    // tag lookup on every write would be paid for nothing.
    const noTags = new Map<string, ManagedTemplateTag>();
    const templates = resources.map((resource) => toManagedTemplate(resource, noTags));
    const byId = new Map(templates.map((template) => [String(template.id), template]));

    const changed = resources.flatMap((resource) => {
      const template = byId.get(String(resource.id));
      if (template === undefined) {
        return [];
      }
      const desired = withCurrentVersionFlag(
        resource,
        isMostRecentActiveVersion(template, templates),
      );
      return desired === resource ? [] : [desired];
    });

    if (changed.length === 0) {
      return;
    }

    await this.medplum.executeBatch({
      resourceType: 'Bundle',
      type: 'transaction',
      entry: changed.map((resource) => ({
        request: { method: 'PUT' as const, url: `MessageDefinition/${resource.id}` },
        resource,
      })),
    });
  }

  /** Attach the tag records behind each resource's `meta.tag`, in one read for the whole set. */
  private async hydrate(resources: MessageDefinition[]): Promise<ManagedTemplate[]> {
    if (resources.length === 0) {
      return [];
    }
    const slugs = new Set(resources.flatMap(readTemplateTagSlugs));
    const tagsBySlug =
      slugs.size === 0 ? new Map<string, ManagedTemplateTag>() : indexBySlug(await this.allTags());
    return resources.map((resource) => toManagedTemplate(resource, tagsBySlug));
  }

  private async allTags(): Promise<ManagedTemplateTag[]> {
    return (await this.searchTagResources([tagKindTuple()])).map(toManagedTag);
  }

  private async tagsForSlugs(slugs: string[]): Promise<ManagedTemplateTag[]> {
    const bySlug = indexBySlug(await this.allTags());
    return slugs.flatMap((slug) => {
      const tag = bySlug.get(slug);
      return tag === undefined ? [] : [tag];
    });
  }

  private async requireResource(
    templateKey: string,
    version: number | null,
  ): Promise<MessageDefinition> {
    const resources = await this.searchTemplateResources([
      templateKindTuple(),
      ['identifier', `${IDENTIFIER_SYSTEM.key}|${escapeSearchValue(templateKey)}`],
    ]);
    if (resources.length === 0) {
      throw new ManagedTemplateNotFoundError(describeMissing(templateKey, null));
    }

    const withVersions = resources.map((resource) => ({
      resource,
      version: Number.parseInt(resource.version ?? '1', 10),
    }));

    if (version !== null) {
      const match = withVersions.find((entry) => entry.version === version);
      if (match === undefined) {
        throw new ManagedTemplateNotFoundError(describeMissing(templateKey, version));
      }
      return match.resource;
    }

    // Latest by version number, not by the string FHIR stores it as: "10" sorts below "2".
    return withVersions.reduce((latest, entry) => (entry.version > latest.version ? entry : latest))
      .resource;
  }

  private async findTagResource(slug: string): Promise<Basic | null> {
    const normalized = slugifyTag(slug);
    const resources = await this.searchTagResources([
      tagKindTuple(),
      ['identifier', `${IDENTIFIER_SYSTEM.tagSlug}|${escapeSearchValue(normalized)}`],
    ]);
    return resources[0] ?? null;
  }

  private async requireTagResource(slug: string): Promise<Basic> {
    const resource = await this.findTagResource(slug);
    if (resource === null) {
      throw new ManagedTemplateTagNotFoundError(`No tag with slug '${slug}' was found.`);
    }
    return resource;
  }

  private async insertTag(text: string, tenant: string | null): Promise<ManagedTemplateTag> {
    const slug = await nextAvailableSlug(
      slugifyTag(text),
      async (candidate) => (await this.findTagResource(candidate)) !== null,
    );
    const created = await this.medplum.createResource(
      buildTagResource({ text, slug, status: 'active', tenant, createdAt: new Date() }),
    );
    return toManagedTag(created);
  }

  /**
   * Move every template carrying `previousSlug` onto the renamed tag.
   *
   * A template's `meta.tag` holds the slug, not a reference, which is what makes tag filtering a
   * server-side query — and what means a rename has to rewrite the rows. Templates are retagged
   * one at a time; a failure partway leaves some rows on the old slug, which
   * `updateTag`'s caller sees as the error it is.
   */
  private async retagTemplates(previousSlug: string, tag: ManagedTemplateTag): Promise<void> {
    if (previousSlug === tag.slug) {
      return;
    }
    for (const resource of await this.searchTemplatesCarryingTag(previousSlug)) {
      const slugs = readTemplateTagSlugs(resource).map((slug) =>
        slug === previousSlug ? tag.slug : slug,
      );
      const tags = await this.tagsForSlugs(slugs);
      await this.medplum.updateResource(withTemplateTags(resource, tags));
    }
  }

  private async searchTemplatesCarryingTag(slug: string): Promise<MessageDefinition[]> {
    return this.searchTemplateResources([
      templateKindTuple(),
      ['_tag', `http://vintasend.com/fhir/managed-template-tag|${escapeSearchValue(slug)}`],
    ]);
  }

  private async searchStatusChanges(templateResourceIds: string[]): Promise<Provenance[]> {
    if (templateResourceIds.length === 0) {
      return [];
    }
    return this.searchAll<Provenance>('Provenance', [
      [
        'target',
        templateResourceIds.map((id) => `MessageDefinition/${escapeSearchValue(id)}`).join(','),
      ],
    ]);
  }

  private async searchTemplateResources(tuples: SearchTuples): Promise<MessageDefinition[]> {
    return this.searchAll<MessageDefinition>('MessageDefinition', tuples);
  }

  private async searchTagResources(tuples: SearchTuples): Promise<Basic[]> {
    return this.searchAll<Basic>('Basic', tuples);
  }

  /**
   * Every resource matching a search, paged through to the end.
   *
   * Bounded by `maxScan` and throwing when it is reached, rather than returning what fitted: a
   * caller cannot tell a short page from a complete one, so silent truncation would turn a store
   * that outgrew its bound into wrong answers instead of a fixable error.
   */
  private async searchAll<ResourceType>(
    resourceType: 'MessageDefinition' | 'Basic' | 'Provenance',
    tuples: SearchTuples,
  ): Promise<ResourceType[]> {
    const collected: ResourceType[] = [];

    for (let offset = 0; ; offset += this.pageSize) {
      const page = (await this.medplum.searchResources(resourceType, [
        ...tuples,
        ['_count', String(this.pageSize)],
        ['_offset', String(offset)],
      ])) as unknown as ResourceType[];

      collected.push(...page);

      if (page.length < this.pageSize) {
        return collected;
      }
      if (collected.length >= this.maxScan) {
        throw new Error(
          `[MedplumTemplateManager] a ${resourceType} read passed the ${this.maxScan}-resource ` +
            'scan limit. Narrow the filter, or raise `maxScan` if the store really is this large.',
        );
      }
    }
  }

  private cleanText(text: string): string {
    const cleaned = normalizeTagText(text);
    if (!cleaned || !slugifyTag(cleaned)) {
      throw new ManagedTemplateInvalidTagError(
        `Tag text ${JSON.stringify(text)} has no characters that can be turned into a slug.`,
      );
    }
    return cleaned;
  }
}

function indexBySlug(tags: ManagedTemplateTag[]): Map<string, ManagedTemplateTag> {
  return new Map(tags.map((tag) => [tag.slug, tag]));
}

function describeMissing(templateKey: string, version: number | null): string {
  if (version === null) {
    return `No template with key '${templateKey}' was found.`;
  }
  return `Template '${templateKey}' has no version ${version}.`;
}

export { deriveIsAbstract };
