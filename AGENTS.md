# NovaChat Agent Instructions

## Release and production deployment

When the user asks to publish a release, complete the entire release-and-deploy
workflow. Do not stop after creating the GitHub Release.

- By default, increment only the patch component: `vX.Y.Z` becomes
  `vX.Y.(Z+1)`. Change the major or minor component only when the user says so.
- Run `scripts/release-and-deploy.sh` from the clean, up-to-date `main` branch.
- GitHub Actions builds the container image and worker artifacts only. Production
  deployment must be initiated by Codex from this trusted host over SSH; do not
  add production SSH credentials or an automatic deploy job to GitHub Actions.
- Wait for both release workflows to succeed before deploying production.
- Do not report completion until the production container is healthy, its image
  tag matches the release, the local HTTP check returns 200, and the database
  migration/quick checks pass.
- The production SSH target belongs in the host-local deployment configuration,
  never in the repository. See `docs/release-and-deploy.md`.

For a deployment retry without creating another release, run:

```bash
scripts/deploy-production.sh vX.Y.Z
```
