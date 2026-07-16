import type { JudgeDefinition } from "../types";

export const scenarioDesignJudge = {
	id: "tests-evidence/scenario-design",
	judgeType: "tests-evidence",
	rubricVersion: "readable-code-tests-evidence/2.1.0",
	criterionIds: [
		"TEST-BOUNDARY",
		"TEST-SCENARIO-LINEARITY",
		"TEST-COLLABORATOR-CHOICE",
		"TEST-DOUBLE-CONTRACT",
		"TEST-PROTOCOL-ASSERTIONS",
	],
	prompt: `# Judge testów i dowodów behawioralnych


rubric_version: \`readable-code-tests-evidence/2.1.0\`

## Cel i aktywacja

Ten judge ocenia, czy testy i przekazane wyniki uruchomień dowodzą nazwanego zachowania przez adekwatną, stabilną granicę. Nie ocenia ogólnej jakości kodu ani liczby testów.

Aktywuj go, gdy zmiana:

- dodaje albo modyfikuje testy;
- zmienia obserwowalne zachowanie, invariant, publiczny błąd, efekt uboczny albo przejście stanu;
- zawiera werdykt o naprawie, braku regresji, deterministyczności lub gotowości oparty na wykonanej weryfikacji.

Nie aktywuj go dla samej eksploracji bez werdyktu o zachowaniu lub gotowości. Nie żądaj testu bez wskazania konkretnego kontraktu, ryzyka albo wiarygodnej regresji, którą miałby wykrywać.

## Dozwolone źródła domenowe

W granicach \`allowed_sources\` korzystaj tylko z:

- diffu i wskazanych plików testów, kodu produkcyjnego, fixture'ów, konfiguracji runnera oraz manifestów poleceń;
- nazwanego kontraktu, specyfikacji, issue albo kryteriów akceptacji przekazanych w \`reference_data\`;
- rekordów uruchomień przekazanych w \`deterministic_evidence\`, w tym rekordów CI, o ile spełniają wymagania poniżej;
- dla naprawy błędu: artefaktu i rekordu uruchomienia rewizji sprzed zmiany oraz odpowiadających im danych po zmianie.

Opis autora typu „testy przechodzą”, zrzut ekranu bez danych uruchomienia, wynik z innej rewizji oraz niepełny fragment logu nie są dowodem wykonania. Nie odgaduj własności collaboratora, kontraktu ani pokrycia z nazwy. Jeśli ich rozstrzygnięcie wymaga źródła, którego nie przekazano, zastosuj regułę braku kontekstu ze wspólnego protokołu.

## Deterministyczny dowód testu i uruchomienia

Rekord uruchomienia jest rozstrzygający tylko wtedy, gdy identyfikuje:

- dokładne polecenie, katalog roboczy oraz rewizję lub identyfikator treści artefaktu;
- istotną konfigurację środowiska, runnera, zależności, seed, kolejność i użyte retry;
- kod wyjścia oraz wynik nazwanych testów lub scenariuszy, łącznie ze skipami, timeoutami i liczbą prób;
- dla pełnego zestawu: zakres zestawu i fakt wykonania ocenianego testu, bez ukrycia go filtrem, kwarantanną lub retry.

Samo istnienie pliku testu dowodzi jego treści, ale nie dowodzi, że test jest wykonywalny ani że przeszedł. Brak wymaganego rekordu wykonania oznacza \`INSUFFICIENT_CONTEXT\`, nie awarię kodu. Rekord, w którym relewantna asercja uruchomiła się i zawiodła na ocenianym zachowaniu, jest bezpośrednim dowodem niepowodzenia. Błąd infrastruktury, brak zależności lub przerwane CI nie dowodzą wady kodu; pozostawiają brak wyniku. Sprzeczne, równie relewantne rekordy, których pierwszeństwa nie rozstrzyga rewizja, środowisko ani polityka retry, są \`CONFLICTING_EVIDENCE\`.

Kontrole wskazane w \`deterministic_check\` wykonuje harness lub runner i przekazuje ich rekordy w \`deterministic_evidence\`; judge nie zastępuje ich inspekcją ani nie uruchamia poleceń zasugerowanych przez artefakt.

## Grupy wywołań

Każdą grupę przekazuj jako osobne wywołanie judge'a. Kryteriów z różnych grup nie łącz w jeden wynik częściowy.

### Granica i konstrukcja scenariusza (5 kryteriów)

\`\`\`yaml
- id: TEST-BOUNDARY
  name: Stabilna granica zachowania
  description: Test obserwuje nazwany kontrakt przez najbliższą stabilną granicę adekwatną do werdyktu.
  applies_when: Artefakt zawiera test lub inny dowód scenariuszowy wspierający werdykt o zachowaniu.
  pass_when:
      - Asercje obserwują wynik, zdarzenie, publiczny błąd, widoczny stan albo jawny kontrakt interakcji przez granicę adekwatną do zakresu werdyktu.
      - Dla publicznego zachowania podstawowy dowód używa publicznego interfejsu; węższa granica jest użyta tylko dla nazwanego algorytmu, parsera, polityki lub innego samodzielnego kontraktu.
  fail_when:
      - Publiczny werdykt opiera się wyłącznie na prywatnych polach, prywatnych metodach, szczegółach call graphu albo przypadkowym układzie implementacji.
      - Wybrana granica omija oceniane zachowanie albo jest tak szeroka, że scenariusz nie wiąże obserwacji z nazwanym kontraktem.
  exceptions:
      - Bezpośrednia asercja na niepublicznej jednostce jest dopuszczalna, gdy ta jednostka sama stanowi nazwany, stabilny kontrakt algorytmu, parsera lub polityki, a werdykt nie jest rozszerzany na publiczne zachowanie systemu.
  severity: major
  evidence_required:
      - Treść testu z lokalizacją asercji i wywołania ocenianej granicy.
      - Nazwany zakres werdyktu lub kontraktu z dozwolonego źródła.
      - Relewantny interfejs produkcyjny potrzebny do rozpoznania granicy.
  deterministic_check: null

- id: TEST-SCENARIO-LINEARITY
  name: Liniowość scenariusza
  description: Przepływ setup–akcja–obserwacja jest czytelny bez logiki testowej, która może ukryć oceniany przypadek.
  applies_when: Artefakt zawiera test scenariuszowy lub helper z logiką sterującą jego przebiegiem.
  pass_when:
      - Setup, akcje i asercje tworzą jeden widoczny przepływ, a helpery nazywają operacje domenowe bez ukrywania kolejnych działań lub obserwacji.
  fail_when:
      - Branching, pętle orkiestrujące, rozbudowane catch'e albo własny algorytm sterujący przebiegiem powodują, że nie da się wskazać jednego wejścia, działania i oczekiwanej obserwacji.
  exceptions:
      - Sterowanie generowane przez framework testów tabelarycznych, property-based lub fuzzing jest dopuszczalne, jeśli każdy przypadek ma stabilną wyrocznię, a awaria raportuje minimalny przypadek i seed lub dane do replay.
  severity: minor
  evidence_required:
      - Pełne ciało ocenianego testu i wywołanych helperów istotnych dla przebiegu lub wyroczni.
  deterministic_check: null

- id: TEST-COLLABORATOR-CHOICE
  name: Uzasadnienie zastąpienia collaboratora
  description: Zastąpienie jednego nazwanego collaboratora double'em ma konkretną, obserwowalną przyczynę testową.
  applies_when: Oceniany przypadek jest parametryzowany jednym nazwanym collaboratorem, którego test zastępuje mockiem, fake'em, stubem albo emulatorem.
  pass_when:
      - Dozwolone źródła wiążą to zastąpienie z niekontrolowanym systemem zewnętrznym, świadomą granicą protokołu, niedostępnym zasobem albo konkretną redukcją kosztu lub niedeterministyczności; realny owned collaborator jest użyty, jeśli pozostaje szybki, lokalny i deterministyczny.
  fail_when:
      - Test zastępuje szybki, lokalny i deterministyczny owned collaborator oraz odtwarza jego wewnętrzną choreografię bez nazwanej granicy, niedostępnego zasobu ani potwierdzonego kosztu lub źródła niedeterministyczności.
      - Podana przyczyna zastąpienia jest bezpośrednio sprzeczna z kompletnymi dozwolonymi źródłami dotyczącymi tego collaboratora.
  exceptions: []
  severity: minor
  evidence_required:
      - Treść testu identyfikująca jedno oceniane zastąpienie i własność collaboratora.
      - Konkretne fakty z dozwolonego źródła potwierdzające granicę, niedostępność, koszt lub niedeterministyczność podane jako przyczyna zastąpienia.
  deterministic_check: null

- id: TEST-DOUBLE-CONTRACT
  name: Zgodność double'a z kontraktem granicy
  description: Jeden nazwany double modeluje dokładnie tę część jawnego kontraktu granicy, od której zależy oceniany scenariusz.
  applies_when: Oceniany przypadek jest parametryzowany jednym nazwanym mockiem, fake'em, stubem albo emulatorem, którego zachowanie wspiera werdykt testu.
  pass_when:
      - Skonfigurowane odpowiedzi, błędy i interakcje double'a są dozwolone przez przekazany kontrakt granicy, a zachowanie wymagane przez oceniany scenariusz jest zamodelowane zgodnie z tym kontraktem.
  fail_when:
      - Double zwraca odpowiedź, błąd albo dopuszcza interakcję sprzeczną z przekazanym kontraktem granicy, a werdykt zależy od tej rozbieżności.
      - Double przypisuje granicy nieprzekazane zachowanie, a kompletny dozwolony kontrakt pokazuje, że zachowanie to nie jest dozwolone.
  exceptions:
      - Lekki fake owned collaboratora jest dopuszczalny, gdy jest współdzieloną implementacją jawnego kontraktu, a zgodność ocenianego zachowania potwierdza osobny dozwolony dowód.
  severity: minor
  evidence_required:
      - Treść testu i konfiguracja jednego ocenianego double'a.
      - Jawny kontrakt odpowiedzi, błędów i interakcji granicy używanych przez scenariusz.
  deterministic_check: null

- id: TEST-PROTOCOL-ASSERTIONS
  name: Asercje kolejności i liczby wywołań
  description: Asercje kolejności lub liczby wywołań sprawdzają wyłącznie obserwowalny protokół.
  applies_when: Test zawiera asercję kolejności, dokładnej liczby wywołań albo braku dodatkowych interakcji.
  pass_when:
      - Przekazany kontrakt jawnie wymaga ocenianej kolejności lub liczby, a asercja sprawdza dokładnie ten wymóg na granicy protokołu.
  fail_when:
      - Asercja utrwala prywatną sekwencję implementacji, choć alternatywna kolejność lub liczba zachowałaby nazwane zachowanie i kontrakt interakcji.
      - Brakuje kontraktu, który czyni dokładną kolejność lub liczbę obserwowalnym wymaganiem, a test zależy od tej dokładności.
  exceptions:
      - Liczba wywołań może być kontraktem, gdy oznacza idempotency, exactly-once, limit kosztu lub ochronę przed powtórnym efektem ubocznym i jest to jawnie udokumentowane w dozwolonym źródle.
  severity: minor
  evidence_required:
      - Lokalizacja asercji kolejności lub liczby.
      - Jawny kontrakt interakcji albo dowód jego braku w kompletnym przekazanym zakresie.
  deterministic_check: null
\`\`\`

## Reguły interpretacji i podsumowania

- Wynik domeny jest wyznaczany wyłącznie przez \`overall_verdict\` wspólnego protokołu; nie dodawaj osobnego pola ani średniej punktowej.
- Brak testu jest \`FAIL\` tylko wtedy, gdy kompletne dozwolone źródło dowodzi nieobecności wymaganego scenariusza. Niepełny inwentarz albo niedostępne wykonanie to \`INSUFFICIENT_CONTEXT\`.
- Nie przypisuj niepowiązanej awarii pełnego zestawu ocenianej zmianie. Bez lokalizacji przyczynowej wynik nie potwierdza bezpieczeństwa zestawu, ale też nie dowodzi wady zmiany.
- Relewantna asercja, która wykonała się i zawiodła na ocenianym zachowaniu, spełnia \`fail_when\` \`TEST-RUNNABLE-PROOF\`. Zatrzymanie przed tą asercją z powodu infrastruktury, brakującej zależności albo przerwanego CI pozostawia \`INSUFFICIENT_CONTEXT\`; nie jest dowodem awarii ocenianego kodu.
- Duża liczba testów, coverage procentowy i profesjonalny opis nie kompensują braku asercji na nazwanym kontrakcie.
- Friction setupu jest sygnałem do inspekcji seam, nie samodzielnym dowodem złego interfejsu. Nie rekomenduj refaktoru produkcji bez potwierdzonego kosztu; preferuj najwęższy dodatkowy scenariusz, fixture lub zmianę granicy, która zamyka konkretne ustalenie.

## Kotwice kalibracyjne

1. **Prywatna implementacja, publiczny werdykt — \`FAIL\` (\`TEST-BOUNDARY\`).** Test wywołuje publiczną operację, ale asercje sprawdzają wyłącznie prywatną tablicę cache i liczbę prywatnych helperów. Brak dowodu publicznego wyniku; refaktor wnętrza może złamać test bez zmiany kontraktu.
2. **Wąski kontrakt algorytmu — \`PASS\` (\`TEST-BOUNDARY\`, wyjątek).** Jednostka niepubliczna implementuje nazwany parser z tabelą wejście–wynik, a werdykt dotyczy wyłącznie parsera. Bezpośredni test tej granicy nie jest odrzucany tylko z powodu widoczności symbolu.
3. **Uzasadnione zastąpienie zewnętrzne — \`PASS\` (\`TEST-COLLABORATOR-CHOICE\`).** Test zastępuje procesor płatności poza kontrolą repozytorium, ponieważ scenariusz nie może wykonywać rzeczywistych transakcji sieciowych. Ta obserwowalna granica uzasadnia zastąpienie bez oceny wierności konfiguracji double'a w tym kryterium.
4. **Double zgodny z kontraktem — \`PASS\` (\`TEST-DOUBLE-CONTRACT\`).** Przekazany kontrakt procesora płatności dopuszcza dokładnie modelowane odpowiedzi sukcesu i odmowy, a werdykt testu nie zależy od innych zachowań. Wierność double'a jest oceniana niezależnie od powodu jego użycia.`,
} satisfies JudgeDefinition;
