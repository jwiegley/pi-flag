# pi-flag

`pi-flag` is a standalone Pi extension for session-scoped significance flags. The implementation is in progress and the package is private and unlicensed until release decisions are made.

## Compatibility

pi-flag 0.1.x supports `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` versions `>=0.84.3 <0.85.0`; tested against 0.84.3. Other Pi minor lines are unsupported until tested.

## Security and privacy

Pi extensions execute with full user privileges. Review this package before installing it.

The completed extension will resend user-selected session text to the active model provider on future runs in that session. Unflagging will stop future projection but cannot erase session history or prior provider requests.

This package has zero runtime dependencies and no installation lifecycle scripts. Development dependencies are exact-pinned and installed with lifecycle scripts disabled.
