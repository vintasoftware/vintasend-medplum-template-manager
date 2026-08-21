/**
 * The storage seam, exercised against Medplum's in-memory FHIR repository.
 *
 * Every assertion here mirrors one in `vintasend-managed-templates`'
 * `in-memory-backend.test.ts`, because the point of a seam is that two implementations of it are
 * interchangeable — a test that passes for one and not the other is a bug in whichever is second.
 */

import { MockClient } from '@medplum/mock';
import {
  type ManagedTemplateCreateInput,
  ManagedTemplateNotFoundError,
  ManagedTemplateTagAlreadyExistsError,
  ManagedTemplateTagNotFoundError,
} from 'vintasend-managed-templates';
import { beforeEach, describe, expect, it } from 'vitest';

import { MedplumTemplateManagerBackend } from '../medplum-template-manager-backend.js';

function createInput(
  key: string,
  overrides: Partial<ManagedTemplateCreateInput> = {},
): ManagedTemplateCreateInput {
  return {
    key,
    name: key,
    description: '',
    templateManagedBackend: 'medplum',
    bodyTemplate: '<p>hi</p>',
    subjectTemplate: 'Hi',
    preheaderTemplate: null,
    tenant: null,
    ...overrides,
  };
}

let medplum: MockClient;
let backend: MedplumTemplateManagerBackend;

beforeEach(() => {
  medplum = new MockClient();
  backend = new MedplumTemplateManagerBackend(medplum);
});

describe('versions', () => {
  it('starts a new template at version 1 in draft', async () => {
    const template = await backend.createTemplate(createInput('welcome'));

    expect(template.version).toBe(1);
    expect(template.status).toBe('draft');
    expect(template.key).toBe('welcome');
    expect(template.bodyTemplate).toBe('<p>hi</p>');
    expect(template.subjectTemplate).toBe('Hi');
  });

  it('stores a template as a MessageDefinition a plain FHIR client can read', async () => {
    await backend.createTemplate(createInput('welcome', { name: 'Welcome email' }));

    const [resource] = await medplum.searchResources('MessageDefinition', {});

    expect(resource?.resourceType).toBe('MessageDefinition');
    expect(resource?.url).toBe('urn:vintasend:managed-template:welcome');
    expect(resource?.version).toBe('1');
    expect(resource?.name).toBe('welcome');
    expect(resource?.title).toBe('Welcome email');
    expect(resource?.status).toBe('draft');
  });

  it('copies the latest version forward and starts the copy in draft', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'active',
    });

    const next = await backend.updateTemplate('welcome', { name: 'Welcome!' });

    expect(next.version).toBe(2);
    expect(next.status).toBe('draft');
    expect(next.name).toBe('Welcome!');
    expect(next.bodyTemplate).toBe('<p>hi</p>');
  });

  it('leaves the version it copied from exactly as it was', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'active',
    });
    await backend.updateTemplate('welcome', { bodyTemplate: '<p>new</p>' });

    const first = await backend.getTemplate('welcome', 1);

    expect(first.status).toBe('active');
    expect(first.bodyTemplate).toBe('<p>hi</p>');
  });

  it('resolves an absent version to the latest one, numerically', async () => {
    await backend.createTemplate(createInput('welcome'));
    for (let version = 2; version <= 11; version += 1) {
      await backend.updateTemplate('welcome', {});
    }

    // The version FHIR stores is a string, where "10" sorts below "2".
    expect((await backend.getTemplate('welcome')).version).toBe(11);
  });

  it('reports a missing key and a missing version differently', async () => {
    await backend.createTemplate(createInput('welcome'));

    await expect(backend.getTemplate('nope')).rejects.toThrow(ManagedTemplateNotFoundError);
    await expect(backend.getTemplate('welcome', 9)).rejects.toThrow(/has no version 9/);
  });

  it('deletes one version, never the whole key', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.updateTemplate('welcome', {});

    await backend.deleteTemplate('welcome', 2);

    expect((await backend.getTemplate('welcome')).version).toBe(1);
  });

  it('re-derives isAbstract from the new version rather than carrying it forward', async () => {
    await backend.createTemplate(
      createInput('base', { bodyTemplate: '<b>{% managed_children %}</b>' }),
    );
    expect((await backend.getTemplate('base')).isAbstract).toBe(true);

    const next = await backend.updateTemplate('base', { bodyTemplate: '<b>concrete</b>' });

    expect(next.isAbstract).toBe(false);
  });

  it('stores isAbstract as false rather than failing a write on a malformed tag', async () => {
    const template = await backend.createTemplate(
      createInput('broken', { bodyTemplate: '{% managed_endblock %}' }),
    );

    expect(template.isAbstract).toBe(false);
  });

  it('round-trips a tenant', async () => {
    const template = await backend.createTemplate(createInput('welcome', { tenant: 'acme' }));

    expect(template.tenant).toBe('acme');
    expect((await backend.getTemplate('welcome')).tenant).toBe('acme');
  });
});

describe('status history', () => {
  it('records every change with who made it, as a Provenance', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'active',
      changedBy: 'ana',
    });

    const history = await backend.getTemplateStatusHistory('welcome');

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      status: 'active',
      version: 1,
      changedBy: 'ana',
      templateKey: 'welcome',
    });

    const provenance = await medplum.searchResources('Provenance', {});
    expect(provenance).toHaveLength(1);
  });

  it('reports an unattributed change as null rather than as a name', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'active',
    });

    expect((await backend.getTemplateStatusHistory('welcome'))[0]?.changedBy).toBeNull();
  });

  it('keeps inactive and archived apart, which FHIR publication status cannot', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'inactive',
    });
    expect((await backend.getTemplate('welcome')).status).toBe('inactive');

    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'archived',
    });
    expect((await backend.getTemplate('welcome')).status).toBe('archived');
  });

  it('narrows to one version when asked', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.updateTemplate('welcome', {});
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'active',
    });
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 2,
      status: 'active',
    });

    expect(await backend.getTemplateStatusHistory('welcome', 2)).toHaveLength(1);
    expect(await backend.getTemplateStatusHistory('welcome')).toHaveLength(2);
  });

  it('reports a missing key rather than an empty trail', async () => {
    await expect(backend.getTemplateStatusHistory('nope')).rejects.toThrow(
      ManagedTemplateNotFoundError,
    );
  });

  it('clears a version audit trail when the version is deleted', async () => {
    await backend.createTemplate(createInput('welcome'));
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'active',
    });

    await backend.deleteTemplate('welcome', 1);

    expect(await medplum.searchResources('Provenance', {})).toHaveLength(0);
  });
});

describe('tags', () => {
  it('creates tags on the fly when a template names them', async () => {
    const template = await backend.createTemplate(
      createInput('welcome', { tags: ['Black Friday'] }),
    );

    expect(template.tags.map((tag) => tag.slug)).toEqual(['black-friday']);
    expect(await backend.getTags()).toHaveLength(1);
  });

  it('resolves a text that slugs onto an existing tag to that tag', async () => {
    await backend.createTemplate(createInput('a', { tags: ['Black Friday'] }));
    const second = await backend.createTemplate(createInput('b', { tags: ['black friday'] }));

    expect(await backend.getTags()).toHaveLength(1);
    expect(second.tags[0]?.text).toBe('Black Friday');
  });

  it('does not bring an archived tag back by re-using it', async () => {
    await backend.createTemplate(createInput('a', { tags: ['sale'] }));
    await backend.setTagStatus('sale', 'archived');

    const second = await backend.createTemplate(createInput('b', { tags: ['sale'] }));

    expect(second.tags[0]?.status).toBe('archived');
  });

  it('refuses an explicit create that collides', async () => {
    await backend.createTag('Sale');

    await expect(backend.createTag('sale')).rejects.toThrow(ManagedTemplateTagAlreadyExistsError);
  });

  it('regenerates the slug on a rename, suffixing a collision', async () => {
    await backend.createTag('Sale');
    const other = await backend.createTag('Clearance');

    const renamed = await backend.updateTag(other.slug, 'Sale');

    expect(renamed.slug).toBe('sale-2');
    expect(renamed.text).toBe('Sale');
  });

  it('moves the templates carrying a renamed tag onto its new slug', async () => {
    await backend.createTemplate(createInput('welcome', { tags: ['Sale'] }));

    await backend.updateTag('sale', 'Clearance');

    expect((await backend.getTemplateTags('welcome')).map((tag) => tag.slug)).toEqual([
      'clearance',
    ]);
    expect(await backend.getFilteredTemplates({ includesAllTags: ['clearance'] })).toHaveLength(1);
  });

  it('looks a tag up by the text it was created from', async () => {
    await backend.createTag('Black Friday');

    expect((await backend.getTag('Black Friday')).slug).toBe('black-friday');
  });

  it('keeps every link when a tag is archived and severs them when it is deleted', async () => {
    await backend.createTemplate(createInput('welcome', { tags: ['sale'] }));

    await backend.setTagStatus('sale', 'archived');
    expect(await backend.getTemplateTags('welcome')).toHaveLength(1);

    await backend.deleteTag('sale');
    expect(await backend.getTemplateTags('welcome')).toHaveLength(0);
  });

  it('reports a missing tag', async () => {
    await expect(backend.getTag('nope')).rejects.toThrow(ManagedTemplateTagNotFoundError);
  });

  it('narrows tags by status, search and tenant', async () => {
    await backend.createTag('Black Friday', 'acme');
    await backend.createTag('Cyber Monday', 'other');
    await backend.setTagStatus('cyber-monday', 'archived');

    expect(await backend.getTags(['active'])).toHaveLength(1);
    expect(await backend.getTags(null, 'monday')).toHaveLength(1);
    expect(await backend.getTags(null, null, 'acme')).toHaveLength(1);
  });

  it('retags a version in place, without spawning one', async () => {
    await backend.createTemplate(createInput('welcome', { tags: ['a'] }));

    const retagged = await backend.setTemplateTags('welcome', ['b', 'c']);

    expect(retagged.version).toBe(1);
    expect(retagged.tags.map((tag) => tag.slug)).toEqual(['b', 'c']);
  });

  it('clears a version tags with an empty list', async () => {
    await backend.createTemplate(createInput('welcome', { tags: ['a'] }));

    expect((await backend.setTemplateTags('welcome', [])).tags).toEqual([]);
  });
});

describe('filtering', () => {
  beforeEach(async () => {
    await backend.createTemplate(createInput('welcome', { name: 'Welcome email' }));
    await backend.createTemplate(createInput('receipt', { name: 'Receipt email' }));
  });

  it('matches a bare string as a case-sensitive exact match', async () => {
    expect(await backend.getFilteredTemplates({ key: 'welcome' })).toHaveLength(1);
    expect(await backend.getFilteredTemplates({ key: 'Welcome' })).toHaveLength(0);
  });

  it('honours every string lookup, including the ones FHIR has no modifier for', async () => {
    expect(
      await backend.getFilteredTemplates({ name: { lookup: 'startsWith', value: 'Welcome' } }),
    ).toHaveLength(1);
    expect(
      await backend.getFilteredTemplates({ name: { lookup: 'endsWith', value: 'email' } }),
    ).toHaveLength(2);
    expect(
      await backend.getFilteredTemplates({
        name: { lookup: 'includes', value: 'RECEIPT', caseSensitive: false },
      }),
    ).toHaveLength(1);
  });

  it('combines fields with AND and groups with and/or/not', async () => {
    expect(await backend.getFilteredTemplates({ key: 'welcome', status: 'draft' })).toHaveLength(1);
    expect(
      await backend.getFilteredTemplates({ or: [{ key: 'welcome' }, { key: 'receipt' }] }),
    ).toHaveLength(2);
    expect(await backend.getFilteredTemplates({ not: { key: 'welcome' } })).toHaveLength(1);
  });

  it('matches all of no tags and none of any of no tags', async () => {
    expect(await backend.getFilteredTemplates({ includesAllTags: [] })).toHaveLength(2);
    expect(await backend.getFilteredTemplates({ includesAnyOfTags: [] })).toHaveLength(0);
  });

  it('accepts a tag named by the text behind its slug', async () => {
    await backend.setTemplateTags('welcome', ['Black Friday']);

    expect(await backend.getFilteredTemplates({ includesAllTags: ['black friday'] })).toHaveLength(
      1,
    );
  });

  it('requires every tag for includesAllTags and one for includesAnyOfTags', async () => {
    await backend.setTemplateTags('welcome', ['x', 'y']);
    await backend.setTemplateTags('receipt', ['x']);

    expect(await backend.getFilteredTemplates({ includesAllTags: ['x', 'y'] })).toHaveLength(1);
    expect(await backend.getFilteredTemplates({ includesAnyOfTags: ['x', 'y'] })).toHaveLength(2);
  });

  it('filters on the stored isAbstract flag', async () => {
    await backend.createTemplate(
      createInput('base', { bodyTemplate: '<b>{% managed_children %}</b>' }),
    );

    expect(await backend.getFilteredTemplates({ isAbstract: true })).toHaveLength(1);
    expect(await backend.getFilteredTemplates({ isAbstract: false })).toHaveLength(2);
  });

  it('keeps only the current version of each key for mostRecentActiveVersion', async () => {
    await backend.updateTemplate('welcome', {});
    await backend.updateTemplate('welcome', {});

    const current = await backend.getFilteredTemplates({ mostRecentActiveVersion: true });

    expect(current.filter((template) => template.key === 'welcome')).toHaveLength(1);
    expect(current.find((template) => template.key === 'welcome')?.version).toBe(3);
  });

  it('drops a key whose versions are all retired', async () => {
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'active',
    });
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'archived',
    });

    const current = await backend.getFilteredTemplates({ mostRecentActiveVersion: true });

    expect(current.some((template) => template.key === 'welcome')).toBe(false);
  });

  it('treats mostRecentActiveVersion false as the exact complement', async () => {
    await backend.updateTemplate('welcome', {});

    const older = await backend.getFilteredTemplates({ mostRecentActiveVersion: false });

    expect(older.map((template) => `${template.key}@${template.version}`)).toEqual(['welcome@1']);
  });

  it('filters on a version number', async () => {
    await backend.updateTemplate('welcome', {});

    expect(await backend.getFilteredTemplates({ key: 'welcome', version: 2 })).toHaveLength(1);
    expect(
      await backend.getFilteredTemplates({ key: 'welcome', version: { lookup: 'gte', value: 2 } }),
    ).toHaveLength(1);
  });

  it('narrows by status', async () => {
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'active',
    });

    expect(await backend.getFilteredTemplates({ status: 'active' })).toHaveLength(1);
    expect(
      await backend.getFilteredTemplates({ status: { lookup: 'in', value: ['active', 'draft'] } }),
    ).toHaveLength(2);
  });

  it('pages a filtered result 1-indexed', async () => {
    const first = await backend.getPaginatedFilteredTemplates({}, 1, 1);
    const second = await backend.getPaginatedFilteredTemplates({}, 2, 1);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.key).not.toBe(second[0]?.key);
  });

  it('lists templates by status', async () => {
    await backend.createTemplateStatusUpdate({
      templateKey: 'welcome',
      version: 1,
      status: 'active',
    });

    expect(await backend.getTemplatesByStatus(['active'])).toHaveLength(1);
    expect(await backend.getTemplatesByStatus([])).toHaveLength(0);
  });
});

describe('capabilities', () => {
  it('declares no limitation, because in-memory evaluation leaves none', () => {
    expect(backend.getFilterCapabilities()).toEqual({});
  });
});

describe('scan limit', () => {
  it('throws rather than returning a page that looks complete', async () => {
    const bounded = new MedplumTemplateManagerBackend(medplum, { maxScan: 2, pageSize: 2 });
    for (const key of ['a', 'b', 'c']) {
      await bounded.createTemplate(createInput(key));
    }

    await expect(bounded.getAllTemplates()).rejects.toThrow(/scan limit/);
  });

  it('returns everything when the store fits inside the bound', async () => {
    const bounded = new MedplumTemplateManagerBackend(medplum, { maxScan: 10, pageSize: 2 });
    for (const key of ['a', 'b', 'c']) {
      await bounded.createTemplate(createInput(key));
    }

    expect(await bounded.getAllTemplates()).toHaveLength(3);
  });
});
