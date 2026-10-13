# Magic keywords

Magic keywords are standalone prose words in a user prompt that can add hidden, user-attributed instructions for that turn. Notice injection is enabled by default. The TUI animates recognized words while the editor is focused and shows static highlights in sent messages. Disabling the global switch stops editor animation and hidden notices, but leaves static highlighting and spelling exemptions in place. Recognized words are exempt from macOS spelling autocorrect and typo underlines.

The full list — trigger word, gradient, settings copy, and notice — lives in one table, `packages/coding-agent/src/modes/magic-keywords.ts`; every other surface (settings, notice injection, editor highlighting) derives from it.

## Keywords

| Keyword       | Effect                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ultrathink`  | Adds a careful multi-step reasoning notice. When automatic thinking is active, it also selects the highest reasoning effort supported by the current model for that turn, bypassing `providers.autoThinkingMaxEffort`.                                                                                                                                                 |

Use the keyword anywhere in the prose of the prompt:

```text
ultrathink about the failure modes before changing this API
```

## Matching rules

Matching is deliberate so source code and paths do not accidentally change agent behavior:

- Use the exact lowercase spelling. `Ultrathink` does not trigger.
- The keyword must be standalone prose. Sentence punctuation and quotes may touch it, but letters, digits, underscores, slashes, backslashes, hyphens, file extensions, symbol references, and call syntax do not match. For example, `ultrathink,` matches; `ultrathinking`, `ultrathink.ts`, `foo::ultrathink`, and `ultrathink()` do not.
- Fenced code blocks (backticks or tildes), inline code spans, HTML/XML comments/tags/elements, and their contents are ignored.
- All enabled keywords in one prompt may add their own notice. The visible word remains in the user message; hidden notices are non-displayed custom messages attributed to the user.
- Matching uses the expanded prompt, after slash-command and prompt-template expansion. Synthetic, agent-initiated prompts do not trigger notices.
- The instruction applies only to the turn containing the keyword.

## Configuration

Open `/settings` and use **Interaction → Magic Keywords**, or change the settings from a shell:

```bash
# Disable every magic keyword
omp config set magicKeywords.enabled false

# Disable one keyword while leaving the others enabled
omp config set magicKeywords.ultrathink false
```

The global switch and the per-keyword switches default to `true`. The global switch gates every hidden notice and editor animation; a per-keyword switch gates only that notice (and ultrathink's maximum-auto-thinking override). Static highlighting and spelling exemptions remain. Run `omp config list` to inspect every setting and its current value. See [Settings](./settings.md) for configuration scopes, precedence, and project-local overrides.
