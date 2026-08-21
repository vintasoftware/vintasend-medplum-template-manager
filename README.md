# vintasend-medplum-template-manager

Medplum/FHIR storage for
[VintaSend managed templates](https://github.com/vintasoftware/vintasend-ts-managed-templates):
an implementation of `BaseTemplateManagerBackend` that keeps template versions, tags and the
status audit trail as ordinary FHIR resources.

If you already run VintaSend on Medplum with
[vintasend-medplum](https://github.com/vintasoftware/vintasend-medplum/), this is the matching
piece for templates: notifications live in `Communication`, and now the templates behind them live
in `MessageDefinition` — in the same project, under the same access policies, backed up by the
same infrastructure.

## Install

```bash
npm install vintasend-medplum-template-manager
```

Peers: `@medplum/core`, `@medplum/fhirtypes`, `vintasend`, `vintasend-managed-templates`.

## Quick start

```ts
import { MedplumClient } from '@medplum/core';
import {
  ManagedTemplateEmailRenderer,
  ManagedTemplateService,
} from 'vintasend-managed-templates';
import { MedplumTemplateManagerBackend } from 'vintasend-medplum-template-manager';

const medplum = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL });
await medplum.startClientLogin(process.env.MEDPLUM_CLIENT_ID, process.env.MEDPLUM_CLIENT_SECRET);

const managerBackend = new MedplumTemplateManagerBackend(medplum);
const renderer = new ManagedTemplateEmailRenderer<Config>(managerBackend, innerRenderer);
const service = new ManagedTemplateService<Config>(managerBackend, renderer);

await service.createTemplate({
  key: 'welcome',
  name: 'Welcome email',
  description: 'Sent right after signup',
  templateManagedBackend: 'medplum',
  bodyTemplate: '<p>Hi #{name}, welcome!</p>',
  subjectTemplate: 'Welcome aboard',
  preheaderTemplate: null,
  tenant: null,
  tags: ['onboarding'],
});

await service.activate('welcome', null, 'hugo@example.com');
```

Everything else — composition, the lifecycle, tags, filtering — is
[`vintasend-managed-templates`](https://github.com/vintasoftware/vintasend-ts-managed-templates)
and is documented there. This package only decides where the bytes go.

### Options

```ts
new MedplumTemplateManagerBackend(medplum, {
  urlPrefix: 'https://acme.example/fhir/templates/', // default: urn:vintasend:managed-template:
  maxScan: 5000, // resources one read will pull back before throwing
  pageSize: 1000, // resources per search request; Medplum caps this at 1000
});
```

Give a deployment its own `urlPrefix` when one Medplum project holds templates for more than one
application: it is the canonical `MessageDefinition.url`, so it is what tells them apart to
anything reading the project as plain FHIR.

## How it is stored

| Managed concept | FHIR resource |
|---|---|
| A template *version* | `MessageDefinition`, versioned by `url` + `version` |
| A tag | `Basic`, FHIR's escape hatch for a concept it does not model |
| A status change | `Provenance`, which is what FHIR calls an audit record |

`MessageDefinition` is not a stretch. FHIR describes it as "the definition of a message that can
be sent", identified by a canonical URL and a version — which is a managed template exactly. So
the natural fields are used for what they are for:

| Managed field | FHIR |
|---|---|
| `key` | `url` (as `<urlPrefix><key>`) and `name` |
| `version` | `version` |
| `name` | `title` |
| `description` | `description` |
| `templateManagedBackend` | `publisher` |
| `status` | `status`, coarsely — see below |
| `createdAt` | `date` |
| `updatedAt` | `meta.lastUpdated` |
| tags | `meta.tag`, under the `managed-template-tag` system |
| `bodyTemplate` / `subjectTemplate` / `preheaderTemplate` | extensions |
| `tenant` | an extension, plus an identifier |

A template's `MessageDefinition` reads sensibly to anything that is not this package — a FHIR
browser, an access policy, a report.

### Why the identifiers

Each of `key`, `status`, `templateManagedBackend` and `isAbstract` is *also* written as an
`identifier`. That is not redundancy for its own sake: `identifier` is a token search — exact,
case-sensitive, repeatable for AND and comma-separable for OR — and every FHIR server answers
those the same way, whereas string search semantics vary by modifier and by server. Queries narrow
on the identifiers; the natural fields are for readers.

### Statuses

FHIR's publication status has four values and only one of them is "retired", so `inactive` and
`archived` both map onto it. The managed status is therefore read back from the status
*identifier*, which keeps all four, and `MessageDefinition.status` is the summary a FHIR client
sees. A resource written by something other than this package has no identifier, so its FHIR
status is read as a best effort — and `retired` resolves to `inactive`, the reversible of the two,
because guessing wrong toward a terminal status would take a template's future away.

### Tags

A template's tags live in `meta.tag` as codings. That is what makes tag filtering a server-side
query: repeating `_tag` is AND, which is `includesAllTags`, and comma-separating values is OR,
which is `includesAnyOfTags`.

It also means a rename has to rewrite the rows — the coding holds the slug, not a reference — so
`updateTag` retags every template carrying the old slug. `deleteTag` does the same in reverse,
taking the label off each template before removing the tag resource.

## Filtering

FHIR search is an AND of parameters with no general OR and no general negation. So a filter is
pushed down as far as it goes and **finished in memory** with the library's own evaluator.

The result is that every filter the vocabulary defines works — `or`, `not`, `endsWith`,
case-insensitive matching, and `mostRecentActiveVersion`, which is a comparison against a key's
other rows that no query language expresses. `getFilterCapabilities()` returns `{}` for exactly
that reason: a backend declares only what it *cannot* do, and this one has no filter it must
refuse, so no caller should drop one.

What is pushed into the FHIR search, and what is left to memory:

| Pushed down | Left to the in-memory pass |
|---|---|
| `key` / `templateManagedBackend`, exact and case-sensitive | the other string lookups, and any case-insensitive one |
| `status`, `isAbstract` | `version` |
| `includesAllTags`, `includesAnyOfTags` | `name`, `description` |
| `createdAtRange`, `updatedAtRange` | anything inside an `or` or a `not` |
| `mostRecentActiveVersion: true` (narrowed to active/draft) | the `mostRecentActiveVersion` comparison itself |

Narrowing never excludes a row the filter would have kept — that is the one rule every branch of
the translation obeys — so an unpushable filter is slower, never wrong.

### The scan bound

Because filters finish in memory, a read scans. `maxScan` (5000 by default) bounds it, and
**throws** when it is reached rather than returning what fitted: a caller cannot tell a short page
from a complete one, so silent truncation would turn a store that outgrew its bound into wrong
answers instead of a fixable error.

A template store is a vocabulary rather than an event log — hundreds of rows, not millions — so
the default is generous. If you genuinely have more, raise it.

## What FHIR does not give you

**No transaction around read-then-insert.** `updateTemplate` reads the latest version and inserts
`n + 1`. Two concurrent updates can both read the same latest and both write the same number. That
is a duplicate version number rather than a lost write: both resources exist, both are readable,
and the later one wins every "latest" resolution. Put the writes behind your own lock if that
matters — the seam has no way to ask FHIR for one.

**No cascade.** Deleting a version deletes its `MessageDefinition` first and then its
`Provenance` records, in that order on purpose: a failure partway through leaves the thing the
caller asked about gone rather than leaving it in place with a trail that no longer records how it
got there. Orphaned `Provenance` resources are unreachable through this backend — history is
looked up through a live version — so a failed cleanup is untidy rather than wrong, and it is
logged through the injected logger.

## Development

```bash
npm install
npm test
npm run typecheck
npm run lint
```

Tests run against `@medplum/mock`, which evaluates real FHIR search parameters, so what passes
here is what a Medplum server will do. Every assertion in `src/__tests__/backend.test.ts` mirrors
one in the library's `in-memory-backend.test.ts` — the point of a seam is that two implementations
of it are interchangeable.

## License

MIT
