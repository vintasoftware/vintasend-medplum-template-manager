/**
 * The backend under the service it is meant to sit beneath.
 *
 * The unit tests above check the seam in isolation; these check the thing an application actually
 * assembles — service, composer and renderer over a FHIR store — because composition resolving
 * against the store is the one part that only works if reads behave the way the composer expects.
 */

import { MockClient } from '@medplum/mock';
import type {
  AnyNotification,
  BaseNotificationTemplateRenderer,
  ContextGenerator,
  EmailTemplate,
  JsonObject,
} from 'vintasend';
import {
  type ManagedEmailTemplateContent,
  type ManagedTemplateCreateInput,
  ManagedTemplateEmailRenderer,
  ManagedTemplateService,
} from 'vintasend-managed-templates';
import { beforeEach, describe, expect, it } from 'vitest';

import { MedplumTemplateManagerBackend } from '../medplum-template-manager-backend.js';

type TestConfig = {
  ContextMap: Record<string, ContextGenerator>;
  NotificationIdType: string;
  UserIdType: string;
};

/** Interpolates `{name}` placeholders — enough to prove the composed source reached the engine. */
class EchoEmailRenderer implements BaseNotificationTemplateRenderer<TestConfig, EmailTemplate> {
  async renderFromTemplateContent(
    _notification: AnyNotification<TestConfig>,
    content: ManagedEmailTemplateContent,
    context: JsonObject,
  ): Promise<EmailTemplate> {
    const fill = (source: string): string =>
      source.replace(/\{(\w+)\}/g, (whole, key: string) => {
        const value = context[key];
        return value === undefined ? whole : String(value);
      });
    return { subject: fill(content.subject ?? ''), body: fill(content.body) };
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

function createInput(
  key: string,
  overrides: Partial<ManagedTemplateCreateInput> = {},
): ManagedTemplateCreateInput {
  return {
    key,
    name: key,
    description: '',
    templateManagedBackend: 'medplum',
    bodyTemplate: '<p>Hi {name}</p>',
    subjectTemplate: 'Welcome',
    preheaderTemplate: null,
    tenant: null,
    ...overrides,
  };
}

let backend: MedplumTemplateManagerBackend;
let service: ManagedTemplateService<TestConfig, EmailTemplate>;

beforeEach(() => {
  backend = new MedplumTemplateManagerBackend(new MockClient());
  service = new ManagedTemplateService(
    backend,
    new ManagedTemplateEmailRenderer<TestConfig>(backend, new EchoEmailRenderer()),
  );
});

describe('the whole stack over Medplum', () => {
  it('publishes a template and renders it', async () => {
    await service.createTemplate(createInput('welcome'));
    await service.activate('welcome', null, 'ana');

    const result = await service.render(notification('welcome'), { name: 'Ana' });

    expect(result.version).toBe(1);
    expect(result.rendered).toEqual({ subject: 'Welcome', body: '<p>Hi Ana</p>' });
  });

  it('resolves composition against the FHIR store before the engine runs', async () => {
    await service.createTemplate(
      createInput('base-email', {
        bodyTemplate: '<html>{% managed_children %}{% managed_include "footer" %}</html>',
        subjectTemplate: '[Acme] {% managed_children %}',
      }),
    );
    await service.createTemplate(createInput('footer', { bodyTemplate: '<footer>bye</footer>' }));
    await service.createTemplate(
      createInput('welcome', {
        bodyTemplate: '{% managed_extends "base-email" %}<p>Hi {name}</p>',
        subjectTemplate: '{% managed_extends "base-email" %}Welcome aboard',
      }),
    );

    const result = await service.render(notification('welcome'), { name: 'Ana' });

    expect(result.rendered.body).toBe('<html><p>Hi Ana</p><footer>bye</footer></html>');
    expect(result.rendered.subject).toBe('[Acme] Welcome aboard');
  });

  it('composes against a pinned parent version', async () => {
    await service.createTemplate(
      createInput('base', { bodyTemplate: 'v1:{% managed_children %}' }),
    );
    await service.updateTemplate('base', { bodyTemplate: 'v2:{% managed_children %}' });
    await service.createTemplate(
      createInput('welcome', { bodyTemplate: '{% managed_extends "base" version=1 %}Hi' }),
    );

    expect((await service.getComposedTemplate('welcome')).bodyTemplate).toBe('v1:Hi');
  });

  it('renders the version a notification is pinned to, however many follow', async () => {
    await service.createTemplate(createInput('welcome', { bodyTemplate: 'v1' }));
    await service.updateTemplate('welcome', { bodyTemplate: 'v2' });

    const result = await service.render(notification('welcome', 1), {});

    expect(result.version).toBe(1);
    expect(result.rendered.body).toBe('v1');
  });

  it('lists every version, because this backend cannot collapse them', async () => {
    // The service's default listing asks for one row per key. Medplum declares
    // `fields.mostRecentActiveVersion: false`, so the service drops the filter and the read
    // widens rather than failing — the extra rows are the visible consequence, and the
    // capability report is where a caller finds out why.
    await service.createTemplate(createInput('welcome'));
    await service.updateTemplate('welcome', {});
    await service.createTemplate(createInput('receipt'));

    const listed = await service.getAllTemplates();

    expect(listed.map((template) => `${template.key}@${template.version}`).sort()).toEqual([
      'receipt@1',
      'welcome@1',
      'welcome@2',
    ]);
  });

  it('reports a missing base as a composition error naming the chain', async () => {
    await service.createTemplate(
      createInput('orphan', { bodyTemplate: '{% managed_extends "gone" %}' }),
    );

    await expect(service.getComposedTemplate('orphan')).rejects.toThrow(/'gone'/);
  });

  it('walks the lifecycle and records it', async () => {
    await service.createTemplate(createInput('welcome'));
    await service.activate('welcome', 1, 'ana');
    await service.deactivate('welcome', 1, 'bruno');

    const history = await service.getStatusHistory('welcome');

    expect(history.map((record) => record.status)).toEqual(['inactive', 'active']);
    expect(history[0]?.changedBy).toBe('bruno');
  });

  it('reports the backend limitations through the service', () => {
    const capabilities = service.getBackendSupportedFilterCapabilities();

    expect(capabilities['logical.or']).toBe(false);
    expect(capabilities['fields.mostRecentActiveVersion']).toBe(false);
    expect(capabilities['stringLookups.endsWith']).toBe(false);
    // Merged over the library default, so what the backend does not mention stays supported.
    expect(capabilities['fields.key']).toBe(true);
    expect(capabilities['logical.and']).toBe(true);
  });

  it('reports the orders the backend can serve, and only those', () => {
    expect(service.getSupportedOrderByFields()).toEqual(['key', 'name', 'createdAt', 'updatedAt']);
  });

  it('orders a listing through the whole stack', async () => {
    for (const key of ['charlie', 'alpha', 'bravo']) {
      await service.createTemplate(createInput(key));
    }

    const page = await service.getPaginatedTemplates(1, 10, true, {
      field: 'key',
      direction: 'desc',
    });

    expect(page.map((template) => template.key)).toEqual(['charlie', 'bravo', 'alpha']);
  });

  it('refuses an order the backend cannot apply', async () => {
    await expect(
      service.getPaginatedTemplates(1, 10, true, { field: 'version', direction: 'asc' }),
    ).rejects.toThrow(/orderBy\.version/);
  });

  it('pages without repeating or dropping a row', async () => {
    for (const key of ['charlie', 'alpha', 'bravo', 'delta']) {
      await service.createTemplate(createInput(key));
    }
    const order = { field: 'key', direction: 'asc' } as const;

    const first = await service.getPaginatedTemplates(1, 2, true, order);
    const second = await service.getPaginatedTemplates(2, 2, true, order);

    expect([...first, ...second].map((t) => t.key)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
  });
});
