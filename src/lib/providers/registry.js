// The provider contract and how to add one: .claude/rules/providers.md.

import {AntigravityProvider} from './antigravity.js';
import {ClaudeProvider} from './claude.js';
import {CodexProvider} from './codex.js';

export const PROVIDERS = [ClaudeProvider, CodexProvider, AntigravityProvider];
