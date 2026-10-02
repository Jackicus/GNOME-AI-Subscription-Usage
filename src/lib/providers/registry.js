// The provider contract and how to add one: .claude/rules/providers.md.

import {AntigravityProvider} from './antigravity.js';
import {ClaudeProvider} from './claude.js';
import {CodexProvider} from './codex.js';

const PROVIDERS = new Map([
    [ClaudeProvider.id, ClaudeProvider],
    [CodexProvider.id, CodexProvider],
    [AntigravityProvider.id, AntigravityProvider],
]);

export function allProviders() {
    return [...PROVIDERS.values()];
}
