# App A - Address Structuring Lab

Rayfin (Microsoft Fabric Apps) project. Scaffolded with `rayfin init --template blankapp`, then the `data-modeling` and `functions` capability packs were applied.

| Package | Contents |
| --- | --- |
| `packages/data` | Rayfin entities: AppConfig, AppMembership, AddressRequest, AddressResult, ReviewHistory, AuditEvent, SampleAddress, with row-level policies (`policies.ts`) |
| `packages/shared` | Isomorphic record and API contracts (type aliases, so the generated function schema stays self-contained) |
| `packages/functions` | 18 Rayfin Functions (`function_app.ts`): identity and roles (`identity.ts`, `authz.ts`), existing-agent adapter (`foundry.ts`, `contract.ts`), SQL store via `ctx.Tokens.Sql` (`sqlStore.ts`), audit hash chain (`audit.ts`), business rules (`service.ts`). Unit tests are in `test/` |
| `packages/frontend` | React 19 + Vite + Tailwind. Fabric SSO gate from the template; screens are in `src/pages` |

Commands (run from this folder):

```powershell
npm ci
npm run typecheck          # includes the Rayfin functions-contract validator
npm run lint
npm test                   # functions unit tests + frontend tests
npm run build
npm run functions:typegen  # regenerate packages/functions/src/types.ts after changing a udf.func signature
```

Deploy only through `..\..\scripts\30-Deploy-App.ps1 -App ars`, which pins the workspace ID and item name.
See `..\..\README.md` for the full execution order.