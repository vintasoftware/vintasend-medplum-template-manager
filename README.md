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

Every read is a FHIR query. A filter is either translated completely or refused — nothing is
finished in memory.

FHIR search is an AND of parameters with no general OR and no general negation, so some of the
vocabulary has no translation. Those are **declared** rather than emulated, and
`ManagedTemplateService` drops them before the call:

```ts
service.getBackendSupportedFilterCapabilities();
```

| Declared `false` | Why |
|---|---|
| `logical.or`, `logical.not`, `logical.notNested` | FHIR search ANDs its parameters; there is no disjunction and no negation |
| `fields.version` | `MessageDefinition.version` is a FHIR *string*, so there is no numeric comparison |
| `fields.mostRecentActiveVersion` | It compares a row against its key's other versions. FHIR has no group-by |
| `stringLookups.endsWith` | FHIR offers starts-with, contains and exact. There is no ends-with |

Everything else is answered by the server: `key` and `templateManagedBackend` as identifier
tokens, `name` and `description` as FHIR string searches, `status` and `isAbstract` as tokens,
tags through `_tag`, and both date ranges through `date` and `_lastUpdated`.

**Dropping widens.** A listing that could not collapse to one row per key comes back with every
version instead — visible in the result, unlike an order that was quietly ignored. Read the
capability report before trusting a filter to have narrowed.

### The one combination that throws

FHIR fixes the case sensitivity of each match: the bare parameter is case-insensitive starts-with,
`:contains` is case-insensitive substring, and `:exact` is case-sensitive equality. The capability
vocabulary has a single global `stringLookups.caseSensitive` key rather than one per lookup, so it
cannot express "case-sensitive equality yes, case-sensitive substring no".

That one combination — `{ lookup: 'includes' | 'startsWith', caseSensitive: true }` — throws
`ManagedTemplateInvalidFilterError` instead of being declared away. Answering it case-insensitively
would return rows the caller excluded, which is the silent wrongness this backend no longer does.

> **A caveat on case.** FHIR specifies token search and `:exact` as case-sensitive, and Medplum's
> server implements that, which is why `stringLookups.caseSensitive` is declared `true`. But
> `@medplum/mock` compares case-insensitively across the board, so the test suite records that
> behaviour rather than asserting the spec's. If case-sensitive matching is load-bearing for you,
> confirm it against a real server.

## Ordering

`getPaginatedTemplates` and `getPaginatedFilteredTemplates` take an optional `orderBy`, which
becomes a FHIR `_sort`:

| Field | `_sort` parameter | |
|---|---|---|
| `key` | `name` | ✅ |
| `name` | `title` | ✅ |
| `createdAt` | `date` | ✅ |
| `updatedAt` | `_lastUpdated` | ✅ |
| `version` | — | ❌ FHIR stores it as a string, so sorting puts v10 before v2 |
| `status` | — | ❌ the managed status is an identifier, which has no sort order |

Every `orderBy.*` capability defaults to `false`, so the four that work are declared explicitly and
the two that do not are left alone. Both exclusions were established by running the sorts against
`@medplum/mock`, not by reading the spec.

Unlike a filter, an unsupported order is **refused**, not dropped: an ignored order returns exactly
the right rows in an arbitrary sequence, and nothing downstream can tell.

## Pagination

A page is chosen by the server — `_count` and `_offset` on the same query that carries the filter
and the sort. Page 500 costs what page 1 costs, and no paginated read is bounded by `maxScan`.

### The scan bound

`maxScan` (5000 by default) still bounds the reads that are genuinely unbounded: `getAllTemplates`,
the tag list, and a version's status history. It **throws** when reached rather than returning what
fitted — a caller cannot tell a short page from a complete one, so silent truncation would turn a
store that outgrew its bound into wrong answers instead of a fixable error.

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

Tests run against `@medplum/mock`, which evaluates real FHIR search parameters — `_sort`,
`_offset`, the string modifiers and `_tag` all behave as a server would. Its one known divergence
is case: it compares case-insensitively where FHIR specifies otherwise, which the filtering
section above records.

`src/__tests__/backend.test.ts` mirrors the library's `in-memory-backend.test.ts` wherever the two
backends agree. Where they do not, it asserts the refusal instead — two implementations of a seam
are interchangeable only up to what each declares it can do, and that difference is the capability
report's whole job.

## License

MIT
