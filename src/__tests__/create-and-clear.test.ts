/**
 * The same contract `vintasend-managed-templates` holds the in-memory backend to — creating a key
 * twice, blank and cleared fields — plus the one thing `MockClient` does not do on its own:
 * validate what is written. A real Medplum server in strict mode refuses invalid FHIR, so every
 * resource this backend writes is run through `validateResource` here.
 */

import { indexStructureDefinitionBundle, validateResource } from '@medplum/core';
import { readJson } from '@medplum/definitions';
import type { Bundle, MessageDefinition, Resource, StructureDefinition } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import {
  ManagedTemplateAlreadyExistsError,
  type ManagedTemplateCreateInput,
  type ManagedTemplateEmailRenderer,
  ManagedTemplateService,
} from 'vintasend-managed-templates';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MedplumTemplateManagerBackend } from '../medplum-template-manager-backend.js';

function createInput(
  key: string,
  overrides: Partial<ManagedTemplateCreateInput> = {},
): ManagedTemplateCreateInput {
  return {
    key,
    name: key,
    description: 'A description',
    templateManagedBackend: 'medplum',
    bodyTemplate: '<p>hi</p>',
    subjectTemplate: 'Welcome',
    preheaderTemplate: 'Preview',
    tenant: null,
    ...overrides,
  };
}

let medplum: MockClient;
let service: ManagedTemplateService<never, never, never>;
let written: Resource[];

beforeAll(() => {
  for (const file of ['profiles-types.json', 'profiles-resources.json']) {
    indexStructureDefinitionBundle(readJson(`fhir/r4/${file}`) as Bundle<StructureDefinition>);
  }
});

beforeEach(() => {
  medplum = new MockClient();
  written = [];
  const create = medplum.createResource.bind(medplum);
  medplum.createResource = (async (resource: Resource) => {
    written.push(resource);
    return create(resource);
  }) as typeof medplum.createResource;
  const backend = new MedplumTemplateManagerBackend(medplum, {
    allowDeletingPublishedVersions: true,
  });
  service = new ManagedTemplateService(
    backend,
    // The renderer is never used by these tests; a bare instance satisfies the constructor.
    {} as unknown as ManagedTemplateEmailRenderer<never>,
    { allowDeletingPublishedVersions: true },
  ) as unknown as ManagedTemplateService<never, never, never>;
});

function assertWrittenResourcesAreValid(): void {
  expect(written.length).toBeGreaterThan(0);
  for (const resource of written) {
    expect(() => validateResource(resource)).not.toThrow();
  }
}

describe('creating a key twice', () => {
  it('throws and leaves the versions unchanged', async () => {
    await service.createTemplate(createInput('welcome', { name: 'A' }));
    await service.activate('welcome', 1);

    await expect(service.createTemplate(createInput('welcome', { name: 'B' }))).rejects.toThrow(
      ManagedTemplateAlreadyExistsError,
    );

    const versions = await service.getTemplateVersions('welcome');
    expect(versions.map((v) => [v.version, v.name, v.status])).toEqual([[1, 'A', 'active']]);
  });

  it('numbers a re-created key above the history of its deleted versions', async () => {
    await service.createTemplate(createInput('welcome'));
    await service.activate('welcome', 1);
    await service.updateTemplate('welcome', { name: 'v2' });
    await service.activate('welcome', 2);
    // Published versions leave a status history, which is what keeps their numbers taken.
    await service.deleteTemplate('welcome', 2);
    await service.deleteTemplate('welcome', 1);

    expect((await service.createTemplate(createInput('welcome'))).version).toBe(3);
  });
});

describe('blank subject and preheader', () => {
  it.each(['', '   '])('stores %j on create as no value, in a valid resource', async (blank) => {
    const template = await service.createTemplate(
      createInput('welcome', { subjectTemplate: blank, preheaderTemplate: blank }),
    );

    expect(template.subjectTemplate).toBeNull();
    expect(template.preheaderTemplate).toBeNull();
    const resource = written[0] as MessageDefinition;
    expect(resource.extension?.map((e) => e.url).join()).not.toMatch(/subject|preheader/i);
    assertWrittenResourcesAreValid();
  });

  it('writes valid resources for a blank description too', async () => {
    await service.createTemplate(createInput('welcome', { description: '' }));

    assertWrittenResourcesAreValid();
  });

  it('clears a field on update even when the latest version has one', async () => {
    await service.createTemplate(createInput('welcome'));

    const next = await service.updateTemplate('welcome', {
      subjectTemplate: '',
      preheaderTemplate: '  ',
    });

    expect(next.subjectTemplate).toBeNull();
    expect(next.preheaderTemplate).toBeNull();
    assertWrittenResourcesAreValid();
  });

  it('carries a field forward on null or undefined', async () => {
    await service.createTemplate(createInput('welcome'));

    const next = await service.updateTemplate('welcome', {
      subjectTemplate: null,
      preheaderTemplate: undefined,
    });

    expect(next.subjectTemplate).toBe('Welcome');
    expect(next.preheaderTemplate).toBe('Preview');
    assertWrittenResourcesAreValid();
  });
});
