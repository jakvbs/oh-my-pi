# `omp --agent <name>` — plan implementacji

Status: implementacja zakończona; bieżący kontrakt i proof znajdują się w `issues/01-select-agent-profile.md`  
Klasyfikacja PDD: brownfield feature, pojedynczy publiczny interfejs CLI, produkcyjny vertical slice  
Właściciel interfejsu: `packages/coding-agent/src/main.ts` + parser argumentów CLI  
Publiczna powierzchnia: `omp --agent <name> [pozostałe flagi]`

## Decyzja routingowa PDD

Plan został zrealizowany. Bieżący kontrakt, wynik implementacji i komendy proof znajdują się w `issues/01-select-agent-profile.md`.

## Problem

Definicje agentów odkrywane z `.omp/agents/*.md`, `~/.omp/agent/agents/*.md`, rozszerzeń i zestawu wbudowanego mogą dziś działać tylko jako dzieci narzędzia `task`. CLI root nie przyjmuje nazwy `AgentDefinition`; użytkownik musi ręcznie powtarzać prompt, model, thinking i listę narzędzi przez osobne flagi. Powoduje to dwa niespójne sposoby definiowania tej samej roli.

## Cel

Polecenie:

```bash
omp --agent security-reviewer
```

ma odkryć `security-reviewer` tą samą ścieżką i z tym samym priorytetem co `task`, a następnie użyć przenośnych pól jego `AgentDefinition` jako domyślnych ustawień głównej sesji.

## Domain fit

Status: extension  
Kontekst: uruchamianie głównej sesji coding-agent oraz istniejący katalog task-agentów.  
Istniejące źródła:

- `packages/coding-agent/src/task/discovery.ts` — jedyny właściciel discovery i priorytetów definicji;
- `packages/coding-agent/src/task/types.ts` — `AgentDefinition`;
- `packages/coding-agent/src/main.ts` — translacja flag CLI do `CreateAgentSessionOptions`;
- `packages/coding-agent/src/sdk.ts` — konstrukcja głównej `AgentSession`;
- `packages/coding-agent/src/task/executor.ts` — obecna interpretacja definicji dla subagenta;
- `packages/coding-agent/src/config/model-resolver.ts` — role i override modeli agentów.

Delta językowa: „agent profile” oznacza istniejący `AgentDefinition` wybrany jako profil startowy sesji Main. Nie powstaje drugi format profilu.

## Zakres

### W zakresie

- nowa flaga `--agent <name>` w interaktywnym, print, JSON, RPC i ACP startupie korzystającym ze wspólnego `buildSessionOptions`;
- discovery przez istniejące `discoverAgents(cwd)` i `getAgent(...)`;
- honorowanie obecnego priorytetu project > user > extension/plugin > bundled;
- odrzucenie nazwy nieistniejącej i agenta obecnego w `task.disabledAgents` przed pierwszym wywołaniem providera;
- projekcja przenośnych pól definicji na główną sesję;
- jawna, deterministyczna precedencja flag CLI nad profilem;
- zachowanie dotychczasowego startu, gdy `--agent` nie występuje;
- help CLI, testy kontraktowe i changelog coding-agent.

### Poza zakresem

- promowanie już uruchomionego subagenta do Main;
- zmiana lifecycle, AgentRegistry lub IRC dla zwykłej sesji Main;
- nowe formaty definicji agentów;
- alias kompatybilności typu `--main-agent`;
- automatyczny zapis wybranej nazwy agenta do ustawień globalnych;
- trwałe przypięcie profilu do pliku sesji; podobnie jak `--system-prompt`, wybór jest launch-time i przy `--continue`/`--resume` należy ponownie podać `--agent` albo użyć stałego aliasu/profilu powłoki;
- stosowanie subagentowych pól `blocking` i `output` do interaktywnej sesji Main.

## Publiczny kontrakt

### Happy path

```bash
omp --agent security-reviewer
```

1. CLI ustala cwd tak samo jak obecnie.
2. Discovery wybiera definicję `security-reviewer` według istniejącego priorytetu.
3. Definicja dostarcza domyślne prompt, tools, model, thinking, spawns, autoload skills i read policy.
4. Powstaje zwykła główna sesja: identyfikator `Main`, standardowy transcript i standardowy interaktywny lifecycle.

### Błędy

Nieznana nazwa:

```text
Unknown agent "security-reviewer". Available: designer, librarian, reviewer, scout, sonic, task
```

Wyłączona nazwa:

```text
Agent "security-reviewer" is disabled in settings. Enable it via /agents or choose another agent.
```

Oba przypadki: komunikat na stderr, exit code `1`, brak requestu do providera i brak częściowo rozpoczętej sesji.

### Precedencja

Od najwyższego priorytetu:

1. jawne flagi tego uruchomienia (`--model`, `--thinking`, `--tools`, `--no-tools`, `--system-prompt`, `--append-system-prompt`, `--no-lsp`, `--no-skills`);
2. `task.agentModelOverrides[agentName]` dla modelu wybranego agenta;
3. pola `AgentDefinition`;
4. obecne ustawienia i domyślne zachowanie Main.

`--append-system-prompt` zawsze dopisuje tekst do promptu wynikowego. `--system-prompt` zastępuje body wybranego profilu, ale nie omija standardowego szablonu i kontekstu głównego agenta — zachowuje obecną semantykę `customSystemPrompt`.

## Mapowanie `AgentDefinition` na Main

| Pole                 | Zachowanie w Main                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | wybór profilu i tekst diagnostyczny; nie zmienia registry id `Main`                                                                            |
| `description`        | tylko discovery/help diagnostyczny, nie jest dokładane do promptu                                                                              |
| `systemPrompt`       | `CreateAgentSessionOptions.customSystemPrompt`                                                                                                 |
| `tools`              | `toolNames`, po adaptacji root opisanej niżej                                                                                                  |
| `spawns`             | `CreateAgentSessionOptions.spawns`; przy zdefiniowanym `spawns` narzędzie `task` jest dostępne, o ile nie wygrało jawne `--tools`/`--no-tools` |
| `model`              | lista `modelPattern`; `task.agentModelOverrides[name]` ma pierwszeństwo                                                                        |
| `thinkingLevel`      | domyślne `thinkingLevel`                                                                                                                       |
| `autoloadSkills`     | nazwy są rozwiązywane względem odkrytych skills i ładowane przed pierwszym inputem                                                             |
| `readSummarize`      | sesyjny override `read.summarize.enabled`                                                                                                      |
| `output`             | ignorowane dla Main; nie wymusza `yield` ani structured completion                                                                             |
| `blocking`           | ignorowane; dotyczy wyłącznie dispatchu przez `task`                                                                                           |
| `source`, `filePath` | diagnostyka, bez wpływu na zachowanie                                                                                                          |

### Adaptacja narzędzi

Parser task-agentów automatycznie dodaje `yield` do jawnych list tools. Main nie jest subagentem, dlatego projekcja musi usunąć `yield`, chyba że użytkownik jawnie podał go przez `--tools`.

Jeżeli definicja ma `spawns`, projekcja dodaje `task` do tools, analogicznie do `runSubprocess`. Jeżeli `spawns` nie ma, profil nie otrzymuje `task` automatycznie. Jawne `--tools` lub `--no-tools` zastępuje cały wynik tej projekcji.

Nie należy kopiować subagentowej logiki depth, forced-yield, `blocking`, output-schema ani monitorowania request budget do Main.

## Projekt implementacji

### 1. Parser i help CLI — RED/GREEN

Pliki:

- `packages/coding-agent/src/cli/args.ts`
- `packages/coding-agent/src/cli/flag-tables.ts`
- `packages/coding-agent/src/commands/launch.ts`
- nowy test `packages/coding-agent/test/cli-agent-flag.test.ts`

Zmiana:

- dodać `agent?: string` do `Args`;
- zarejestrować `--agent` jako string-valued flag w `STRING_SETTERS` — to zachowa zgodność z profile bootstrap i obsłuży `--agent=name`;
- dodać flagę do oclifowego help w `commands/launch.ts`;
- nie dodawać skrótu jednoliterowego ani aliasu.

RED:

- `parseArgs(["--agent", "reviewer"])` ustawia `agent: "reviewer"`;
- `parseArgs(["--agent=reviewer"])` zachowuje tę samą wartość;
- wartość nie trafia do `messages`;
- brak wartości pozostawia flagę jako nierozpoznaną/błędną zgodnie z obecną polityką string flags, bez specjalnego fallbacku.

### 2. Resolwer profilu Main — RED/GREEN

Pliki:

- `packages/coding-agent/src/main.ts`
- istniejące `packages/coding-agent/src/task/discovery.ts` i `task/types.ts` tylko jako zależności; nie duplikować discovery;
- test `packages/coding-agent/test/cli-agent-flag.test.ts` lub osobny `main-agent-profile.test.ts`, jeśli plik przekroczy czytelny zakres.

Dodać mały root-specific adapter w `main.ts` przy `buildSessionOptions`:

```ts
resolveMainAgentDefaults(name, cwd, activeSettings);
```

Odpowiedzialność:

1. `discoverAgents(cwd)`;
2. `getAgent(agents, name)`;
3. walidacja `task.disabledAgents`;
4. zbudowanie częściowego `CreateAgentSessionOptions` i ewentualnych sesyjnych settings overrides;
5. żadnego I/O providera ani tworzenia sesji.

Adapter jest root-specific; nie wyciągać wspólnej abstrakcji z `task/executor.ts`, dopóki współdzielony kod nie zmniejszy wiedzy obu callerów. Main i subagent mają różną semantykę `yield`, output, blocking, IRC i recursion depth.

`buildSessionOptions` powinno:

1. zastosować domyślne wartości profilu;
2. wykonać istniejące rozwiązywanie modelu i promptów;
3. na końcu zastosować jawne flagi CLI, które nadpisują profil.

Błąd wyboru profilu ma być normalnym startup error obsłużonym przez `runRootCommand`, nie `process.exit()` wewnątrz adaptera.

### 3. Model i thinking

Użyć istniejącego SDK `modelPattern` zamiast ręcznie rozwiązywać konkretne modele przed discovery extensions.

Reguły:

- `task.agentModelOverrides[name]`, jeśli ustawione, daje pojedynczy najwyższy pattern;
- w przeciwnym razie użyć `agent.model` jako listy patternów/fallbacków;
- jawne `--model` korzysta z obecnej ścieżki `resolveCliModel` i zastępuje patterns profilu;
- jawne `--thinking` zastępuje `agent.thinkingLevel`;
- brak modelu w definicji pozostawia obecny model domyślny Main.

Nie importować wartości katalogowych z `@oh-my-pi/pi-ai`; zachować repozytoryjną konwencję catalog imports.

### 4. Autoload skills i read policy

`readSummarize` zastosować jako nietrwały override aktywnego `Settings` tylko dla tworzonej sesji.

Dla `autoloadSkills` dodać jawny seam do `CreateAgentSessionOptions`, np.:

```ts
autoloadSkillNames?: string[];
```

SDK, po discovery skills i przed pierwszym user inputem, ma rozwiązać nazwy i zastosować tę samą publiczną mechanikę prompt-message, której używa subagent executor. Nie duplikować składania promptów skills. Nie zgadywać brakujących skills: nieznana nazwa powinna dać czytelny startup error z nazwą profilu i skill.

Jeżeli dodanie tego seamu okaże się większe niż około 100 efektywnych LOC lub wymaga zmiany lifecycle `createAgentSession`, wydzielić autoload jako drugi vertical slice. Pierwszy slice nadal musi jawnie zgłosić, że profil zawiera nieobsługiwane `autoloadSkills`; nie wolno ich po cichu ignorować.

### 5. Resume, fork i cache shape

`--agent` jest launch-time override, analogiczny do `--system-prompt` i `--tools`:

- z `--resume`, `--continue` lub `--fork` jawnie ponownie aplikuje profil do nowego procesu;
- bez `--agent` zachowanie resume pozostaje bez zmian;
- dodanie `parsed.agent !== undefined` do `forkCacheShapeChanged` zapobiega odziedziczeniu niezgodnego provider prompt cache key;
- nazwa profilu nie jest w tej iteracji utrwalana w `SessionInitEntry`.

### 6. First-time-user UX

Help powinien zawierać:

```text
--agent <name>  Start Main with a discovered agent definition
```

Błąd nieznanej nazwy powinien wypisać posortowane dostępne nazwy. Błąd wyłączonego agenta powinien wskazać `/agents`. Nie wypisywać pełnych ścieżek ani treści plików definicji.

Opcjonalne późniejsze UX, poza tym slicem: `omp agents list` i shell completion nazw agentów.

## Kryteria akceptacji

- AC-001: `omp --agent <existing>` wybiera projektową/użytkową/pluginową/wbudowaną definicję przez istniejący discovery owner.
- AC-002: wybrany profil ustawia prompt, tools, spawns, model, thinking i read policy Main zgodnie z tabelą mapowania.
- AC-003: `yield`, `output` i `blocking` nie nadają Main subagentowego completion/lifecycle.
- AC-004: jawne flagi CLI mają deterministyczne pierwszeństwo nad profilem.
- AC-005: `task.disabledAgents` blokuje także jawny wybór przez `--agent`.
- AC-006: nieznana nazwa kończy startup kodem 1 przed requestem modelowym i podaje dostępne nazwy.
- AC-007: brak `--agent` zachowuje dotychczasowe opcje sesji bez zmiany.
- AC-008: `--agent` jest widoczne w help i działa w formach `--agent x` oraz `--agent=x`.
- AC-009: wybór profilu podczas resume/fork unieważnia odziedziczony prompt cache key tak jak jawny system prompt/tools.
- AC-010: nieznane `autoloadSkills` nie są po cichu pomijane.

## Plan testów

Testować zachowanie, nie tekst źródeł.

### Parser/publiczny argv

`packages/coding-agent/test/cli-agent-flag.test.ts`:

- obie formy flagi;
- zachowanie kolejnego positional promptu;
- brak regresji dla `--profile` bootstrap;
- help zawiera flagę przez istniejący CLI help seam, jeśli testy help mają stabilny helper.

### Translacja do sesji

Wywołać `buildSessionOptions` z tymczasowym projektem zawierającym `.omp/agents/security-reviewer.md` i izolowanymi settings/model registry:

- projektowa definicja wygrywa z bundled o tej samej nazwie;
- body trafia do `customSystemPrompt`;
- restricted tools nie zawierają automatycznego `yield`;
- `spawns: scout, reviewer` daje CSV i dodaje `task`;
- model patterns, thinking i read policy są przeniesione;
- jawne CLI flags nadpisują każde przenośne pole;
- disabled i unknown dają publiczny startup error;
- bez flagi wynik pozostaje identyczny z dotychczasowym baseline;
- `forkCacheShapeChanged` nie dziedziczy cache key przy `--agent`.

### Autoload skill

Test na sesji z lokalnym testowym skill:

- znany skill zostaje załadowany przed pierwszym promptem;
- brakująca nazwa daje startup error;
- `--no-skills` ma pierwszeństwo i nie ładuje skill profilu.

### Narrow proof commands

Planowane RED/GREEN:

```bash
bun test packages/coding-agent/test/cli-agent-flag.test.ts
bun test packages/coding-agent/test/session-fork-prompt-cache-key.test.ts
bun check
```

Planowany smoke błędu bez zależności od credentials:

```bash
bun packages/coding-agent/src/cli.ts --agent __missing_agent__ -p "noop"
```

Oczekiwany sygnał: exit `1`, dokładny komunikat `Unknown agent`, zero requestów modelowych.

Po GREEN uruchomić źródłowy pozytywny smoke z istniejącym uwierzytelnionym providerem, jeżeli środowisko wykonawcze ma credentials:

```bash
bun packages/coding-agent/src/cli.ts --agent scout -p "Return the current working directory only."
```

Oczekiwany sygnał: odpowiedź pochodzi z sesji Main uruchomionej z restricted tools profilu; brak wymuszonego `yield`. Brak credentials należy zapisać jako brak manualnego smoke, nie zastępować fałszywym sukcesem.

## Reviewability budget i podział

Docelowy budżet całej funkcji: 300–500 efektywnych LOC łącznie z testami; wygenerowane help/snapshoty nie liczą się, jeśli są mechaniczne.

Preferowany pojedynczy vertical slice obejmuje parser, discovery, projekcję, errors, tests i changelog. Rozbić wyłącznie, gdy autoload skills wymaga zmiany lifecycle SDK przekraczającej budżet:

1. `--agent` z prompt/tools/spawns/model/thinking/read policy i jawnym błędem dla profili z `autoloadSkills`;
2. SDK seam dla autoload skills, następnie usunięcie błędu i pełne AC-010.

Nie dzielić poziomo na „parser”, „SDK” i „tests” jako osobne mergeable zmiany — żaden z takich fragmentów sam nie dostarcza działającego interfejsu.

## Ryzyka i zabezpieczenia

1. **Podwójna semantyka AgentDefinition.** Main nie może odziedziczyć forced-yield/output/blocking. Zabezpieczenie: jawna tabela mapowania i kontraktowe testy options/session.
2. **Niejawne obejście disabledAgents.** Zabezpieczenie: walidacja po discovery, przed session creation.
3. **CLI override nadpisany przez profil.** Zabezpieczenie: profil jako defaults, istniejące flagi aplikowane później; osobny test każdego konfliktu.
4. **Role modelowe z extensions rozwiązywane za wcześnie.** Zabezpieczenie: przekazać `modelPattern` do SDK zamiast wymuszać wczesny konkretny model.
5. **Prompt cache po zmianie roli.** Zabezpieczenie: uwzględnić `parsed.agent` w cache-shape invalidation.
6. **Zanieczyszczenie ustawień globalnych read policy.** Zabezpieczenie: użyć sesyjnego override; nie zapisywać konfiguracji.
7. **Nowy agent dodany później obchodzi root allowlist.** Nie dotyczy: `--agent` wybiera dokładnie jedną nazwę, a dalsze spawny podlegają jej `spawns` oraz globalnemu denylistowi.

## Kolejność implementacji PDD

1. Utworzyć `.scratch/main-agent-profile/issues/01-select-agent-profile.md` według `prototype-issue-log.md`; wpisać AC-001–AC-009, publiczny test seam i proof command.
2. RED: parser flagi oraz unknown/disabled selection.
3. GREEN: discovery i minimalna projekcja prompt/tools/spawns bez tworzenia sesji providera.
4. RED: model/thinking/CLI precedence/cache shape.
5. GREEN: pełne portable mapping i override order.
6. RED/GREEN: autoload skills; rozbić slice tylko przy przekroczeniu budżetu zgodnie z sekcją wyżej.
7. Narrow tests, `bun check`, negatywny CLI smoke, następnie pozytywny smoke jeśli credentials są dostępne.
8. First-time-user pass na help i błędach.
9. Dopiero po działającym smoke: wpis `Fixed`/`Added` w `packages/coding-agent/CHANGELOG.md`, final review względem AC, aktualizacja issue outcome i commit pojedynczego zweryfikowanego slice’a.

## Otwarte decyzje

Brak decyzji blokujących rozpoczęcie implementacji. Przyjęte założenia:

- `--agent` jest profilem launch-time, nie trwałą tożsamością session file;
- explicit CLI flags wygrywają;
- disabled agent nie może zostać wybrany jako Main;
- `output` i `blocking` pozostają subagent-only;
- brakujące autoload skill jest błędem, nie cichym pominięciem.
