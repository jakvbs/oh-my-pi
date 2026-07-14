# Extension Tool Customization API — plan implementacji

Status: kontrakt gotowy do implementacji  
Klasyfikacja PDD: brownfield public API extension, jeden reviewowalny vertical slice  
Właściciel interfejsu: `packages/coding-agent/src/extensibility/extensions/`  
Miejsce integracji: budowa `toolRegistry` w `packages/coding-agent/src/sdk.ts`  
Kontrakt: [SPEC.md](./SPEC.md)  
Przypadki: [acceptance-ledger.yaml](./acceptance-ledger.yaml)

## Decyzja routingowa PDD

To jest Phase 0: kontrakt i plan bez zmian zachowania. Zgodnie z playbookiem nie powstaje osobny issue tylko dla utworzenia `SPEC.md`, `PLAN.md` i ledgera. Przy rozpoczęciu implementacji utworzyć `.scratch/tool-customization-api/issues/01-customize-live-tools.md`, wskazać pierwszy przypadek ledgera i prowadzić tam RED/GREEN oraz iteration log.

## Problem i seam

Dziś extension może zarejestrować tool o tej samej nazwie i zastąpić cały built-in, ale nie może pobrać ani udekorować live instancji. `getAllTools()` zwraca wyłącznie nazwy. Próba delegacji przez ponowne skonstruowanie `ReadTool`, `BashTool` itd. traci aktualny `ToolSession` i stan sesji.

Istniejący seam jest jednoznaczny:

1. `ExtensionRuntime.registerTool` zapisuje definicje podczas ładowania modułu;
2. `ExtensionRunner.getAllRegisteredTools()` zachowuje kolejność rozszerzeń;
3. `sdk.ts` składa built-in i registered tools w `toolRegistry` (`sdk.ts:2253-2269`);
4. następnie każdy wpis jest opakowywany przez `ExtensionToolWrapper` (`sdk.ts:2279-2283`).

Customizacje muszą zostać zapisane przy ładowaniu extension, a rozwiązane pomiędzy krokami 3 i 4. Tylko tam dostępna jest finalna live instancja i można zachować wspólną approval/lifecycle boundary.

## Domain fit

Status: extension  
Kontekst: Extension API i per-session tool registry.  
Istniejący język: `registerTool`, `RegisteredTool`, `ExtensionRunner`, `ExtensionToolWrapper`, `toolRegistry`.  
Delta: `tool customization` oznacza uporządkowaną transformację finalnego wpisu rejestru bez ponownego tworzenia jego zależności.  
Nie wprowadzać drugiego rejestru ani provider-specific payload adaptera.

## Reviewability budget

Budżet: 250–400 efektywnych LOC produkcyjnych i kontraktowych testów dla kompletnego slice'a. Nie liczyć wygenerowanych artefaktów ani samego Phase 0. Jeżeli bez late-MCP supportu zmiana przekroczy 400 LOC albo wymaga przebudowy `AgentSession`, zatrzymać implementację i rozdzielić API `patchTool` od `wrapTool`; pierwszy slice ma wtedy dostarczyć wyłącznie `patchTool(description|label)` przez ten sam docelowy registry seam.

## Publiczna decyzja API

Implementować oba seamy z `SPEC.md`:

```ts
pi.patchTool('read', { description: '...' });

pi.wrapTool('read', (original) => ({
    description: `${original.description}\n...`,
    execute: (...args) => original.execute(...args)
}));
```

`patchTool` jest bezpiecznym skrótem tylko dla `description` i `label`. `wrapTool` zwraca częściowy override i jest jawnym escape hatchem dla schema/policy/render/execute. Oba zapisują rejestrację; nie próbują rozwiązać toola podczas importu extension.

`original` nie może być surową mutowalną instancją. Ma być read-only facade z callbackami związanymi z właściwym receiverem. To chroni prywatny stan klas (`#fields`) i zapobiega przypadkowej mutacji wpisu przed walidacją wyniku.

## Slice 1 — rejestracja API i kolejność

### RED

Plik testowy: `packages/coding-agent/test/extensions-runner.test.ts`.

Dodać zachowania:

1. extension może wywołać `patchTool` i `wrapTool` podczas load phase;
2. runner zwraca rejestracje w extension load order;
3. wywołania w jednym extension zachowują call order;
4. patch jest snapshotowany — mutacja obiektu wejściowego po rejestracji nie zmienia zapisanego patcha.

Expected RED: metody nie istnieją w `ExtensionAPI`/runtime albo runner nie ma customizations.

### GREEN

Pliki:

- `packages/coding-agent/src/extensibility/extensions/types.ts`
- `packages/coding-agent/src/extensibility/extensions/loader.ts`
- `packages/coding-agent/src/extensibility/extensions/runner.ts`

Zmiana:

- dodać publiczne typy patcha, read-only handle i decorator callback bez `any` i `ReturnType<>`;
- dodać `patchTool`/`wrapTool` do `ExtensionAPI` i implementacji loadera;
- rozszerzyć `Extension` o uporządkowaną tablicę rejestracji z `extensionPath`;
- dodać runnerowi jeden odczyt/agregację zachowującą kolejność;
- nie używać `Map` dla customizations, bo utraciłby wielokrotne rejestracje tej samej nazwy.

Wąska weryfikacja:

```bash
bun test packages/coding-agent/test/extensions-runner.test.ts
```

Sukces: nowe testy kolejności i snapshotu są zielone; istniejące testy runnera pozostają zielone.

## Slice 2 — atomowa transformacja live registry

### RED

Dodać skoncentrowany test zachowania, preferowane miejsce: nowy `packages/coding-agent/test/sdk-tool-customization.test.ts`.

Minimalny harness składa:

- klasowy fake tool z prywatnym stanem i metodą `execute` zależną od `this`;
- extension rejestrujące patch/decorator;
- sesję tworzoną wspólną ścieżką SDK lub najwęższym istniejącym helperem, który przechodzi przez rzeczywisty etap budowy registry.

Przypadki prowadzić w kolejności ledgera:

1. patched description jest obecny w `agent.state.tools`/provider-visible tool catalog;
2. oryginalne execution dostaje ten sam call id, params, signal i callback oraz zwraca ten sam wynik;
3. bound `original.execute` działa dla klasowego toola z prywatnym stanem;
4. wielokrotne customizations komponują się w ustalonej kolejności;
5. same-name registered tool jest bazą dla późniejszego patcha;
6. wynik nadal przechodzi przez `ExtensionToolWrapper` i lifecycle hooks.

Expected RED: registry nadal zawiera niezmodyfikowany opis albo replacement wymaga skopiowania execution.

### GREEN

Pliki:

- `packages/coding-agent/src/extensibility/extensions/runner.ts`
- `packages/coding-agent/src/sdk.ts`
- ewentualnie jeden nowy, wąski moduł `packages/coding-agent/src/extensibility/extensions/tool-customization.ts` tylko jeżeli wydzielenie atomowej transformacji upraszcza runner i testy; nie tworzyć modułu-forwardera.

Zmiana:

1. Po złożeniu finalnego initial `toolRegistry`, przed pętlą `new ExtensionToolWrapper(...)`, zastosować rejestracje po kolei.
2. Dla każdego toola zbudować read-only facade:
    - skalary odczytywane z aktualnej wersji toola;
    - funkcje związane z aktualnym receiverem;
    - brak możliwości zapisu do live instancji.
3. `patchTool` przekształcić do statycznego override `description`/`label`.
4. `wrapTool` uruchomić raz i walidować wynik przed zmianą registry.
5. Nowy wrapper/adapter ma jawnie delegować wszystkie niezmienione pola; nie używać spreadu na instancji klasy, ponieważ metody prototypu nie są enumerable.
6. Zachować `name` i registry key. Nie dopuścić do rename nawet przez wymuszenie typu w JS extension.
7. Dopiero wynik przekazać do istniejącego `ExtensionToolWrapper`.

Wąska weryfikacja:

```bash
bun test packages/coding-agent/test/sdk-tool-customization.test.ts packages/coding-agent/test/extensions-runner.test.ts
```

Sukces: provider-visible metadata jest zmieniona, klasowy execute zachowuje receiver i call contract, a hook/approval wrapper obserwuje wywołanie.

## Slice 3 — fault isolation i rebuild

### RED

W tym samym pliku kontraktowym dodać:

- missing target;
- decorator throw;
- `null`, primitive lub niepoprawne pole w wyniku JS decoratora;
- próbę rename wykonaną z nietypowanego JS extension;
- poprawną późniejszą customizację po wcześniejszej porażce;
- dwukrotne utworzenie/reload sesji bez podwójnego nałożenia wrappera.

Expected RED: start sesji abortuje, tool jest częściowo zmieniony, późniejszy decorator nie działa albo wrapper stackuje się po rebuildzie.

### GREEN

- Każdą transformację obliczać poza mutacją registry i zatwierdzać dopiero po pełnej walidacji.
- Missing target: jeden warning z target name i extension source, bez tworzenia wpisu.
- Throw/invalid/rename: jeden error diagnostic, zachowanie poprzedniej prawidłowej wersji i kontynuacja kolejki.
- Użyć istniejącego kanału błędów/diagnostyki extension; nie pisać do `console.*`.
- Każdy rebuild zaczyna od świeżego base registry; nie przechowywać customized tool instances w `Extension` ani `ExtensionRunner`.

Weryfikacja:

```bash
bun test packages/coding-agent/test/sdk-tool-customization.test.ts packages/coding-agent/test/extensions-runner.test.ts
```

Sukces: wszystkie failure cases zachowują poprzedni tool, emitują przypisany diagnostic i nie blokują późniejszych transformacji.

## Finalna bramka implementacyjna

Po zazielenieniu wszystkich przypadków ledgera:

```bash
bun test packages/coding-agent/test/sdk-tool-customization.test.ts packages/coding-agent/test/extensions-runner.test.ts
bun --cwd packages/coding-agent run check
bun ~/.agents/scripts/acceptance-ledger.ts report .scratch/tool-customization-api/acceptance-ledger.yaml
```

Expected success:

- oba pliki testowe: zero failures;
- coding-agent check: exit code `0`;
- ledger: brak implementowalnych `red-ready` i `blocked-decision` cases.

## Ryzyka i decyzje utrzymaniowe

- Nie spreadować class instance; utraci to prototypowe `execute` i może dać pozornie zielony metadata test przy zepsutym wykonaniu.
- Nie mutować readonly pól live toola przez cast. Atomowy adapter zachowuje rollback i kompozycję.
- Nie przepuszczać customizacji po `ExtensionToolWrapper`; approval ma oceniać finalną politykę, a hooki mają widzieć finalne wykonanie.
- Nie dodawać late-MCP listenera w tym slice. To osobny lifecycle i osobny przypadek kontraktowy.
- Nie rozszerzać `getAllTools()` o definicje. Read-only decorator facade istnieje wyłącznie podczas kontrolowanej finalizacji registry.
