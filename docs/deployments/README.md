# Deployment records

One folder per deployed environment, named `<org>-<env>` (the `org.code` and environment from `config/ionova.<env>.json`).
Each folder holds identifiers and results only, never credentials:

| File | Written by | Purpose |
| --- | --- | --- |
| `app-register.json` | `scripts/70-Update-Register.ps1` | Application register (AC-01): item IDs, URLs, databases, change log |
| `STATUS.md` | you, from [_template/STATUS.md](_template/STATUS.md) | What is deployed and what has been verified at runtime |
| `READINESS.md` | you, from [../READINESS.md](../READINESS.md) | Readiness record R-00 to R-14 with evidence and owner |

| Folder | Environment |
| --- | --- |
| [ionova-dev](ionova-dev/) | Reference deployment: ioNova Fabric trial (Central India) with a cross-tenant Foundry project (East US 2). Use it as a worked example; do not reuse its IDs. |

The local deployment config (`config/ionova.<env>.json`) and `evidence/` and `exports/` stay git-ignored.
