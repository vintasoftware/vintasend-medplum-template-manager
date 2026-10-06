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
  allowDeletingPublishedVersions: false, // the default; see "Deleting a version"
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

### Which version a send renders

`getActiveTemplate(key)` answers the send path: the highest-numbered version whose managed status
is `active`, compared as a number rather than as the string FHIR stores. Drafts are never sent. A
key with versions but no active one throws `ManagedTemplateNoActiveVersionError`, which
`vintasend-managed-templates` treats as "nothing published yet" — so a renderer's registered
fallback applies. `getTemplate(key)` with no version still returns the newest version of any
status, for editors and the API.

### Deleting a version

`deleteTemplate` deletes only a version that was never published: still `draft`, with no
`Provenance` other than `draft` targeting it. Anything else throws
`ManagedTemplateDeletionNotAllowedError` — archive it instead. That includes a call with no
`version`, which resolves to the latest version and is refused when that version is published.

The `Provenance` resources are **never** deleted. They are the record of who published what, and a
notification pinned to a version is only explainable through them. `allowDeletingPublishedVersions:
true` lifts the status check for an operator who really needs a hard delete — the deletion is then
logged with the resource id — but the `Provenance` trail stays in the store either way.

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
| `stringLookups.endsWith` | FHIR offers starts-with, contains and exact. There is no ends-with |

Everything else is answered by the server: `key` and `templateManagedBackend` as identifier
tokens, `name` and `description` as FHIR string searches, `status` and `isAbstract` as tokens,
tags through `_tag`, and both date ranges through `date` and `_lastUpdated`.

### `mostRecentActiveVersion`, without a group-by

"The highest-numbered active-or-draft version of each key" is a comparison against a key's *other*
rows, and FHIR has no group-by. It is answered anyway, by **denormalization**: each row carries a
`current-version` identifier saying whether it is the one, so the filter is an ordinary token
match — `true` and `false` both, since the flag is stored on every row rather than only the winner.

This is the same trade the seam already asks every backend to make for `isAbstract`: compute at
write time what a read cannot express. Like the padding, it is invisible outside this package —
`ManagedTemplate` carries no such field, and the filter reads exactly as it does against any other
backend.

The cost is on the write side. Four writes can move the answer, and each recomputes the key
afterwards:

| Write | How the answer moves |
|---|---|
| `createTemplate` | a new key's only version becomes current |
| `updateTemplate` | the inserted draft supersedes the version it was copied from |
| `deleteTemplate` | deleting the current version promotes the next one down |
| status change | retiring the current version promotes another; the flag can move *down* |

The winner is decided by the library's own `isMostRecentActiveVersion`, not by a rule re-derived
here, so the stored flag cannot come to mean something different from the filter. One test asserts
the two agree over a whole store.

**A recompute is one search and at most two writes**, and the writes go in a single FHIR
transaction bundle, so a listing never shows a key twice. New rows are written *unflagged* and
promoted afterwards for the same reason: a new version that arrived already current would double
its key. What remains is a window between the write that moved the answer and the recompute, during
which the listing shows the **previous** current version — stale by one write, never doubled and
never empty.

Two concurrent updates can still both insert version `n + 1`; that is the pre-existing
read-then-insert race, and the flag inherits it rather than adding to it.

## Ordering

`getPaginatedTemplates` and `getPaginatedFilteredTemplates` take an optional `orderBy`, which
becomes a FHIR `_sort`:

| Field | `_sort` parameter | |
|---|---|---|
| `key` | `name` | ✅ |
| `name` | `title` | ✅ |
| `createdAt` | `date` | ✅ |
| `updatedAt` | `_lastUpdated` | ✅ |
| `version` | `version` | ✅ via zero-padding — see below |
| `status` | — | ❌ see below |

Every `orderBy.*` capability defaults to `false`, so the five that work are declared explicitly and
the one that does not is left alone. Every entry in that table was established by running the sort,
not by reading the spec — `_sort=version` looked fine until it was given versions 10, 2 and 3.

### Version: zero-padded so the string sort is a numeric one

FHIR stores `MessageDefinition.version` as a *string*, so `_sort=version` compares lexicographically
and puts v10 before v2. This backend writes the version left-padded to
`VERSION_SORT_WIDTH` (12) digits — `000000000010` — which makes the lexicographic order the numeric
order. Reading goes through `Number.parseInt`, so the managed template a caller sees is unchanged.

**The padding is a storage detail of this package and goes no further.** A managed template's
`version` is a `number` everywhere the library, the composition tags and the HTTP contract deal
with it; `formatFhirVersion` is not exported, and reading goes through `Number.parseInt`. The one
place it is visible is a plain FHIR client reading the resource directly: `version` is an
unconstrained string in FHIR so the padding is legal, but a reader comparing it to a literal `"1"`
will not match, and the canonical reference becomes
`urn:vintasend:managed-template:welcome|000000000001`.

A version wider than 12 digits throws rather than sorting wrong — far past any real template
history, but the alternative failure is silent.

### Status: not rescued by the same trick

The managed status lives in an identifier, and token parameters have no sort order. The only
sortable status field is FHIR's own `MessageDefinition.status` — and `inactive` and `archived` both
map into it as `retired`, so it cannot tell two of the four statuses apart. Padding does not help,
because there is no spare sortable field to pad *into*: `name`, `title`, `version`, `date` and
`_lastUpdated` all already carry real data, and a sortable rank in an extension would need a custom
`SearchParameter`, which is server configuration a library cannot assume.

A sort that silently confuses `inactive` with `archived` is worse than no sort, so the capability
stays false.

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

**No cascade, on purpose.** Deleting a version deletes its `MessageDefinition` only. Its
`Provenance` records stay in the project as audit records; this backend looks history up through a
live version, so the trail of a deleted version is no longer listed by `getTemplateStatusHistory`,
but any FHIR client can still read it by `target`.

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
