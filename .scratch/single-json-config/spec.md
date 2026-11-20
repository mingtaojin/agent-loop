Status: ready-for-agent

# Single JSON configuration

Version: 1

## Goal and authorization

Users maintain one private JSON configuration file. The repository commits only a placeholder example. Application credentials live directly in that file.

The coordinator delegated implementation in event `single-config-implementation-v1` from task `c9edaf14-f18a-42de-841e-d963e1f520cc`. The delegation identifies the user's explicit authorization as message `om_x100b60ca1e1928a0c05c23ea7b9df56`, chat `oc_586b1866902382e0db4dff8d25c0f3f7`, sender `ou_5c280b16780ac4016c7455a276b2d95b`. This document records that relayed authorization, not a new product decision by the implementer.

## Confirmed scope

- Store `feishu.appId`, `feishu.appSecret`, and `github.token` directly in JSON. Remove their `*Env` selectors and credential environment lookup.
- Remove application dotenv loading and `--env-file`. Do not retain an optional compatibility path.
- Migrate CLI doctor, collect, run, and owned Feishu pairing and verification helpers together with examples, documentation, and tests.
- Keep normal system and provider environment mechanisms. Keep the existing conditional GitHub token requirement when collection repositories are configured.
- Keep execution hot reload. Valid edits update only execution settings. Invalid edits retain the last valid execution settings. Other settings, including credentials, require restart.
- Ignore private configuration and track only placeholder examples. Do not expose application credentials in validation errors, logs, dashboard or configuration APIs, snapshots, or reports.

## Acceptance

1. A user copies `config/example.json` to ignored `config.json`, fills direct credentials, and runs doctor without a dotenv file or application credential environment variables.
2. Collection and runtime clients receive credentials from JSON. Missing GitHub token is rejected when repositories are configured and allowed when none are configured.
3. Legacy selectors and `--env-file` fail clearly without echoing credential values. An existing dotenv file has no application effect.
4. Pair and verify helpers use the same private JSON file and do not print credentials. Pairing changes only the owner binding in that file.
5. Synthetic secrets do not appear in diagnostic output, validation failures, serialized configuration, dashboard responses, snapshots, or persisted reports.
6. Execution reload behavior and ordinary provider environment inheritance remain covered. Relevant tests, type checking, and build pass.

## Excluded scope

No live configuration or dotenv migration, deletion, or reading of actual credentials. No changes to live property lists. No deployment, service restart, merge, or unrelated coordinator intake work. No alternate credential stores or dotenv compatibility.

## Open questions

None at handoff. New scope changes require coordinator review. Network acceptance using real credentials remains outside this task's authorization.

## Comments

Implementation and independent verification are separate. The PR owner delivers the branch and evidence. The coordinator arranges an independent verifier before a merge decision.
