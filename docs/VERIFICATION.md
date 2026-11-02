# Verification tests

There are two kinds of test:

- **Automated local tests** run without Azure.
- **Deployed runtime tests** must run against the deployed apps with real test accounts.

A local pass is never treated as proof that the deployment works (AI-03, DEL-07).

## 1. Automated local tests (run on every change)

Run from `apps/ars` and from `apps/isolation-b`:

```powershell
npm ci
npm run typecheck   # TypeScript project references + Rayfin functions-contract validator (ars)
npm run lint
npm test            # ars: functions unit tests + frontend tests; isob: frontend tests
npm run build
```

These are the test suites. All test doubles are labelled *TEST DOUBLE* and live only under `test/` or `*.spec.tsx`; they are never deployed (DEL-06).

| Suite | File | What it proves |
| --- | --- | --- |
| Agent contract | `apps/ars/packages/functions/test/contract.test.ts` | The request text matches the reference byte for byte (Python `json.dumps`). All six samples pass validation. Rejects non-JSON, missing or extra keys, values not copied from the input, an inferred country, and null values that have evidence. Shows that the injection case needs evaluation, not text checks. |
| Foundry adapter | `test/foundry.test.ts` | Calls the documented agent endpoint URL with a bearer token, `store:false` and no conversation. Retries once on 429 using Retry-After, never retries 401 or 403, retries 5xx a bounded number of times, maps timeouts, and rejects incomplete responses. |
| Audit, identity, config | `test/audit-identity-config.test.ts` | The hash chain verifies, and edits and deletions are detected. Expired tokens, missing claims and a failed live probe are rejected. Placeholders and bad endpoints are rejected. Fault injection is ignored outside dev. |
| Service rules | `test/service.test.ts` | The full business flow and every PRD AC-03, AC-04 and AC-05 rule against an in-memory store fake (see the mapping below). |
| App shell | `apps/ars/packages/frontend/src/Root.spec.tsx` | No content or backend call before sign-in. Shows app, environment and user, and only permitted navigation. Shows the access-denied page, the no-membership page and the error with correlation ID, the fault banner, sign-out, and fails closed when config is missing. |
| Duplicate submission | `src/pages/SubmitPage.spec.tsx` | The button is disabled while a submission is in flight. A resubmission reuses the same request ID, and an edit creates a new ID. A timeout links to the saved request. |
| App B shell | `apps/isolation-b/packages/frontend/src/Root.spec.tsx` | The sign-in gate for App B. |

## 2. Deployed runtime tests (DEL-07, SET-05, SET-06)

Before you start, complete MANUAL-STEPS M-13 to M-20.

Use these test accounts:

| Account | Fabric item access | In-app roles |
| --- | --- | --- |
| **A-only** | App A only | `app_user` |
| **A-only 2** | App A only | `app_user` |
| **B-only** | App B only | none |
| **Reviewer** | App A | `reviewer` |
| **Reviewer 2** | App A | `reviewer` |
| **Auditor** | App A | `auditor` |
| **Exporter** | App A | `audit_exporter` |
| **Admin** | App A | `app_admin` |
| **Unassigned** | none, and not a workspace member | none |

Record the result, date, tester and correlation IDs for each test in your deployment's `STATUS.md` (`docs/deployments/<org>-<env>/`; the ioNova dev record is [deployments/ionova-dev/STATUS.md](deployments/ionova-dev/STATUS.md)).

**Direct API technique (V-23, V-24):**

1. In the browser, open **DevTools**, then the **Network** tab.
2. Right-click a successful `/functions/<name>/invoke` request and choose **Copy as fetch**.
3. Edit the JSON body (for example, change `requestId`, or call a different function name).
4. Run it in the **Console** of the same tab.

This replays a real authenticated API call with altered input. The app UI is bypassed.

| ID | Test | Steps | Expected result | PRD |
| --- | --- | --- | --- | --- |
| V-01 | Sign-in and sign-out | Open the App A URL in a new InPrivate window, sign in, then **Sign out** | Nothing renders before sign-in. After sign-in the header shows org, project, app, **dev**, your email and roles. After sign-out the sign-in page returns | ORG-02, APP-02 |
| V-02 | Anonymous access blocked | `50-Verify-Deployment.ps1` | The hosting URL doesn't serve the app anonymously | ACC-01 |
| V-03 | Bootstrap once | Bootstrap admin signs in and bootstraps. A second admin tries the same | First succeeds. Second sees no bootstrap button, and a direct call returns ACCESS_DENIED | ACC-03 |
| V-04 | Clean deployment, then seed | Before seeding, **Records** is empty. Run **Seed** twice | Six samples and one config row. The second run creates no duplicates | DATA-05, AC-06 |
| V-05 | Foundry from the deployed backend | Admin selects **Probe existing Foundry agent** | *Reachable, contract valid*. `foundry.probe` SUCCESS appears in audit. This is runtime proof of AI-03 | AI-01, AI-03, SET-04 |
| V-06 | End-to-end flow | A-only submits the India sample | COMPLETED, FIELDS_PRESENT. Fields match. Reloading the page shows the same record. Diagnostics show rows in AddressRequest and AddressResult | AC-03, SET-05 |
| V-07 | Evaluation | Admin selects **Run evaluation (6 live calls)** | Record each sample's match. Agree expected results before sign-off (the injection case may legitimately differ) | AI-06 |
| V-08 | Review with version history | Reviewer opens the missing-country record, sets country `IN`, approves | Version 2, APPROVED. Model output still shows country null. History shows `country: — → IN` | APP-03, AC-03 |
| V-09 | Original input preserved | Compare **Original input** with the submitted text after review | Unchanged | APP-03 |
| V-10 | AI timeout | Fault `aiTimeout`, then A-only submits | AI_TIMEOUT with a correlation ID and a link to the saved request. Status FAILED_AI. After clearing the fault, **Retry processing** completes it | AC-05, APP-05 |
| V-11 | Audit-write failure | Fault `auditWrite`, then submit | AUDIT_FAILURE. No false success. Status FAILED_AUDIT. No result row. Retry after clearing the fault succeeds | AUD-04, AC-05 |
| V-12 | Storage failure | Fault `storageWrite`, then submit | STORAGE_FAILURE. Status FAILED_STORAGE. Recoverable with Retry | AC-05 |
| V-13 | Duplicate submission | Double-click **Structure and save**. Resubmit the same unchanged text after an error | One request only. Resubmission shows *already submitted* | APP-05, AC-05 |
| V-14 | Concurrent edit | Reviewer and Reviewer 2 open the same record. R1 saves, then R2 saves | R2 gets CONFLICT *someone else updated…* and **Reload latest version**. No silent overwrite | DATA-03, AC-05 |
| V-15 | Support lookup | Auditor filters audit by a correlation ID from V-10 or V-11 | Events for that request are listed | LOG-01, §8 support |
| V-20 | A-only vs App B | A-only opens the App B URL | Fabric denies access to the item | PRJ-03, ACC-04 |
| V-21 | B-only vs App A | B-only opens the App A URL, and calls an App A function directly | Fabric denies access to the item. Direct calls fail authentication | PRJ-03, ACC-04 |
| V-22 | Own records only | A-only 2 opens **My records**, then opens `#/records/<A-only's id>` | Empty list. *Record not found* | DATA-02, ACC-04 |
| V-23 | Altered record ID through the API | A-only 2 replays `getRecord` with A-only's `requestId` | `ok:false`, NOT_FOUND. `access.denied` appears in audit | ACC-04 |
| V-24 | Role tampering | A-only replays `submitReview`, `searchAudit`, `listRecords {scope:"all"}` and `grantMembership` (self) | Every call returns ACCESS_DENIED and is audited. There are no client-writable role fields | ACC-03, AC-04 |
| V-25 | Reviewer, auditor, admin separation | Reviewer: no Audit or Admin menu, and direct `searchAudit` is denied. Auditor: no record access. Admin: `getRecord` is NOT_FOUND | Matches the role matrix in PRD §7 | ACC-04 |
| V-26 | Revocation | Admin revokes A-only. A-only refreshes | No role. Own records hidden in the data API and in functions. Measure and record how long it takes to propagate | ORG-03 |
| V-27 | Unassigned user | Unassigned signs in to App A | Fabric item access is denied. If they're shared on the item without a role, they see *No access to this app yet* | ACC-01 |
| V-28 | No cross-user AI context | Two users submit different addresses at the same time | Each result matches its own input. Requests use `store:false` and no conversation | SET-06 |
| V-30 | Audit integrity and export | Auditor selects **Verify integrity**. Exporter selects **Export CSV** | *Audit chain intact*. The CSV downloads, and `audit.exported` is recorded. Auditor sees no Export button | AUD-03, AUD-05 |
| V-31 | Data export reads back | `60-Export-AppData.ps1` | Every table reads back with matching counts and hashes | DATA-04, AC-06 |
| V-32 | Redeploy a versioned build | `80-Rollback-App.ps1 -App ars -GitRef <tag>` on a test tag, then the current tag | Both deploy to the same item. The data persists | AC-06 |
| V-33 | Performance (pilot targets) | 10 concurrent users and 1,000 sample records (see SUPPORT.md *Load test*) | Shell under 3 s after authentication. Non-AI operations under 2 s at p95. AI latency recorded separately | §9 NFR |
| V-34 | Accessibility | Keyboard-only run through submit, review and audit. Check labels and focus rings | Every action is reachable by keyboard. Forms are labelled | §9 NFR |

### Mapping service unit tests to PRD rules

| PRD | Unit test(s) in `service.test.ts` |
| --- | --- |
| AC-03 | *submits, structures, saves…*, *records reviewer edits separately…* |
| AC-04 | *unassigned users…*, *altering the id…*, *only reviewers…*, *auditors read…*, *prevents self-assignment…*, *revocation removes access…* |
| AC-05 | *AI timeout…*, *audit-write failure…*, *nothing is saved…*, *storage failure…*, *duplicate submission…*, *stale concurrent review…* |
| AUD-03 | *detects tampering…* |
| LOG-01 | *finds events by correlation id…* |
| DATA-05 | *seeds idempotently…* |
| AI-06 | *runs a fixed evaluation sample…* |
