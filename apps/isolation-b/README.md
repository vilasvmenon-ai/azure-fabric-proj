# App B - isolation test app

A minimal Rayfin project, deployed as a separate Fabric App item with its own SQL database and Fabric SSO.
It stores owner-scoped test notes (`IsolationNote`, policy `claims.sub = owner_id`) and exists only to prove
PRD PRJ-03 / ACC-04 separation from App A. Its business scope is outside the PRD.

```powershell
npm ci; npm run typecheck; npm run lint; npm test; npm run build
```

Deploy with `..\..\scripts\30-Deploy-App.ps1 -App isob`.