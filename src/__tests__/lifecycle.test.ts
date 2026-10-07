/**
 * Which version a send renders, and which versions may be deleted, over Medplum.
 *
 * Mirrors `send-version-resolution.test.ts` and `deletion.test.ts` in
 * `vintasend-managed-templates`, for the same reason `backend.test.ts` mirrors the in-memory
 * backend's suite: the two implementations of the seam have to be interchangeable.
 */

import { MockClient } from '@medplum/mock';
import type {
  AnyNotification,
  BaseNotificationTemplateRenderer,
  ContextGenerator,
  EmailTemplate,
} from 'vintasend';
import {
  type ManagedEmailTemplateContent,
  type ManagedTemplateCreateInput,
  ManagedTemplateDeletionNotAllowedError,
  ManagedTemplateEmailRenderer,
  ManagedTemplateNoActiveVersionError,
  ManagedTemplateNotFoundError,
  ManagedTemplateService,
} from 'vintasend-managed-templates';
import { beforeEach, describe, expect, it } from 'vitest';

import { STATUS_CHANGE_TAG_SYSTEM } from '../constants.js';
import { MedplumTemplateManagerBackend } from '../medplum-template-manager-backend.js';

type TestConfig = {
  ContextMap: Record<string, ContextGenerator>;
  NotificationIdType: string;
  UserIdType: string;
};

class EchoEmailRenderer implements BaseNotificationTemplateRenderer<TestConfig, EmailTemplate> {
  async renderFromTemplateContent(
    _notification: AnyNotification<TestConfig>,
    content: ManagedEmailTemplateContent,
  ): Promise<EmailTemplate> {
    return { subject: content.subject ?? '', body: content.body };
  }

  async render(): Promise<EmailTemplate> {
    throw new Error('unused');
  }
}

function notification(
  bodyTemplate: string,
  pin: number | null = null,
): AnyNotification<TestConfig> {
  return {
    id: 'notification-1',
    userId: 'user-1',
    notificationType: 'EMAIL',
    title: 'Hi',
    bodyTemplate,
    contextName: 'test',
    contextParameters: {},
    sendAfter: null,
    subjectTemplate: null,
    extraParams: null,
    requestedTemplateVersion: pin,
  } as unknown as AnyNotification<TestConfig>;
}

function createInput(key: string): ManagedTemplateCreateInput {
  return {
    key,
    name: key,
    description: '',
    templateManagedBackend: 'medplum',
    bodyTemplate: 'p v1',
    subjectTemplate: null,
    preheaderTemplate: null,
    tenant: null,
  };
}

let medplum: MockClient;
let backend: MedplumTemplateManagerBackend;
let renderer: ManagedTemplateEmailRenderer<TestConfig>;
let service: ManagedTemplateService<TestConfig, EmailTemplate>;

beforeEach(() => {
  medplum = new MockClient();
  backend = new MedplumTemplateManagerBackend(medplum);
  renderer = new ManagedTemplateEmailRenderer<TestConfig>(backend, new EchoEmailRenderer());
  service = new ManagedTemplateService(backend, renderer);
});

describe('an unpinned send', () => {
  it('renders the published version, not a newer draft', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1);
    await service.updateTemplate('k', { bodyTemplate: 'p v2draft' });

    const rendered = await renderer.render(notification('k'), {});

    expect(rendered.body).toBe('p v1');
    expect(rendered.templateVersion).toBe(1);
  });

  it('throws a not-found subclass for a key that only has drafts', async () => {
    await service.createTemplate(createInput('k'));

    await expect(renderer.render(notification('k'), {})).rejects.toThrow(
      ManagedTemplateNoActiveVersionError,
    );
  });

  it('renders the highest-numbered active version when several are active', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1);
    await service.updateTemplate('k', { bodyTemplate: 'p v2' });
    await service.activate('k', 2);
    await service.updateTemplate('k', { bodyTemplate: 'p v3draft' });

    const rendered = await renderer.render(notification('k'), {});

    expect(rendered.body).toBe('p v2');
  });

  it('compares versions as numbers, not as the strings FHIR stores', async () => {
    await service.createTemplate(createInput('k'));
    for (let version = 2; version <= 10; version += 1) {
      await service.updateTemplate('k', { bodyTemplate: `p v${version}` });
    }
    await service.activate('k', 2);
    await service.activate('k', 10);

    expect((await backend.getActiveTemplate('k')).version).toBe(10);
  });
});

describe('a pinned send', () => {
  it('keeps rendering its pinned version after that version is deactivated', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1);
    await service.deactivate('k', 1);

    expect((await renderer.render(notification('k', 1), {})).body).toBe('p v1');
  });
});

describe('getLatestTemplateVersion', () => {
  it('pins a new notification to the active version, not a newer draft', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1);
    await service.updateTemplate('k', {});

    expect(await renderer.getLatestTemplateVersion('k')).toBe(1);
  });

  it('answers null for a key that only has drafts, or nothing at all', async () => {
    await service.createTemplate(createInput('k'));

    expect(await renderer.getLatestTemplateVersion('k')).toBeNull();
    expect(await renderer.getLatestTemplateVersion('nope')).toBeNull();
  });
});

describe('getActiveTemplate', () => {
  it('tells a missing key apart from a key with no active version', async () => {
    await service.createTemplate(createInput('k'));

    const missing = backend.getActiveTemplate('nope');
    await expect(missing).rejects.toThrow(ManagedTemplateNotFoundError);
    await expect(backend.getActiveTemplate('nope')).rejects.not.toBeInstanceOf(
      ManagedTemplateNoActiveVersionError,
    );
    await expect(backend.getActiveTemplate('k')).rejects.toThrow(
      ManagedTemplateNoActiveVersionError,
    );
  });

  it('hydrates tags like any other read', async () => {
    await service.createTemplate({ ...createInput('k'), tags: ['onboarding'] });
    await service.activate('k', 1);

    expect((await backend.getActiveTemplate('k')).tags.map((tag) => tag.slug)).toEqual([
      'onboarding',
    ]);
  });
});

describe('deleting', () => {
  it('deletes a draft that was never published', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1);
    await service.updateTemplate('k', {});

    await backend.deleteTemplate('k', 2);

    expect((await backend.getTemplate('k')).version).toBe(1);
  });

  it('refuses to delete a published version, and keeps it and its trail', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1, 'reviewer');

    await expect(backend.deleteTemplate('k', 1)).rejects.toThrow(
      ManagedTemplateDeletionNotAllowedError,
    );
    await expect(backend.deleteTemplate('k')).rejects.toThrow(
      ManagedTemplateDeletionNotAllowedError,
    );

    expect((await backend.getTemplate('k', 1)).status).toBe('active');
    expect(await backend.getTemplateStatusHistory('k', 1)).toMatchObject([
      { status: 'active', changedBy: 'reviewer' },
    ]);
  });

  it('refuses through the service too', async () => {
    await service.createTemplate(createInput('k'));
    await service.activate('k', 1);
    await service.deactivate('k', 1);

    await expect(service.deleteTemplate('k', 1)).rejects.toThrow(
      ManagedTemplateDeletionNotAllowedError,
    );
  });

  it('never deletes the Provenance trail, even when a hard delete is allowed', async () => {
    const permissive = new MedplumTemplateManagerBackend(medplum, {
      allowDeletingPublishedVersions: true,
    });
    await permissive.createTemplate(createInput('k'));
    await permissive.createTemplateStatusUpdate({
      templateKey: 'k',
      version: 1,
      status: 'active',
      changedBy: 'reviewer',
    });

    await permissive.deleteTemplate('k', 1);

    await expect(permissive.getTemplate('k', 1)).rejects.toThrow(ManagedTemplateNotFoundError);
    expect(await medplum.searchResources('Provenance', {})).toHaveLength(1);
  });
});

describe('version numbers after a delete', () => {
  let permissive: MedplumTemplateManagerBackend;

  beforeEach(() => {
    permissive = new MedplumTemplateManagerBackend(medplum, {
      allowDeletingPublishedVersions: true,
    });
  });

  async function publishVersion(version: number): Promise<void> {
    await permissive.createTemplateStatusUpdate({ templateKey: 'k', version, status: 'active' });
  }

  it('never reuse a published version number', async () => {
    await permissive.createTemplate(createInput('k'));
    await publishVersion(1);
    await permissive.updateTemplate('k', { bodyTemplate: 'p v2' });
    await publishVersion(2);
    await permissive.deleteTemplate('k', 2);

    const next = await permissive.updateTemplate('k', { bodyTemplate: 'p v3' });

    expect(next.version).toBe(3);
    await expect(permissive.getTemplate('k', 2)).rejects.toThrow(ManagedTemplateNotFoundError);
  });

  it('start a recreated key above every number its history used', async () => {
    await permissive.createTemplate(createInput('k'));
    await publishVersion(1);
    await permissive.deleteTemplate('k', 1);

    expect((await permissive.createTemplate(createInput('k'))).version).toBe(2);
  });

  it('tag each status change with the key and version it was recorded against', async () => {
    await permissive.createTemplate(createInput('k'));
    await publishVersion(1);

    const [provenance] = await medplum.searchResources('Provenance', {});

    expect(provenance?.meta?.tag).toEqual(
      expect.arrayContaining([
        { system: STATUS_CHANGE_TAG_SYSTEM.key, code: 'k' },
        { system: STATUS_CHANGE_TAG_SYSTEM.version, code: '1' },
      ]),
    );
  });
});
