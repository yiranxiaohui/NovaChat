# NovaChat Agent Instructions

## Release and deployment

When the user asks to publish a release, remember to complete the full flow:

1. Default to incrementing only the patch version: `vX.Y.Z` → `vX.Y.(Z+1)`.
2. Publish the tag and GitHub Release, then wait for the container and Worker
   release workflows to succeed.
3. Deploy directly from the current trusted host with SSH to
   `root@114.66.55.93`; do not delegate production deployment to GitHub Actions.
4. Back up `/opt/NovaChat/docker-compose.yml` and the SQLite database, update the
   NovaChat image to the release tag, and recreate only the NovaChat service.
5. Verify the container is healthy with zero restarts, HTTP returns 200,
   migrations and database integrity pass, and recent logs have no critical
   errors before reporting completion.

Keep this as an agent-operated process. Do not add release or deployment scripts
unless the user explicitly asks for automation code.
