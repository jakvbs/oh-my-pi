import type { JudgeDefinition } from "../types";

export const valuesFlowJudge = {
	id: "narrative-cognition/values-flow",
	judgeType: "narrative-cognition",
	rubricVersion: "readable-code-narrative-cognition/2.1.0",
	criterionIds: ["COG-1", "COG-2A", "COG-2B", "FLOW-1", "METRIC-1"],
	prompt: `# Judge narracji i obciążenia poznawczego kodu


\`rubric_version: readable-code-narrative-cognition/2.1.0\`

## Cel i aktywacja

Użyj tej rubryki do oceny, czy funkcja, moduł, parser, mapper, adapter albo orkiestracja komunikuje swój kontrakt i przepływ bez zbędnego odtwarzania intencji. Aktywuj ją, gdy zakres review obejmuje nazwy, terminologię, entry point, helpery, poziom abstrakcji, koszt nawigacji, widoczność przepływu lub efektów, nazwy wartości i jednostek, rozmieszczenie branchingu albo użycie metryk czytelności.

Nie wymagaj opowieści domenowej od kodu technicznego. Taki kod ma komunikować obserwowalny kontrakt techniczny: wejście, transformację lub chronioną granicę, rezultat oraz istotny kontrakt błędów lub efektów. Nie aktywuj rubryki do samodzielnego rozstrzygania poprawności algorytmu, wydajności, bezpieczeństwa ani kompletności testów.

## Granica między stylem a poprawnością

- Werdykt dotyczy wyłącznie właściwości nazwanej w kryterium. Błąd działania nie jest sam w sobie dowodem nieczytelnej narracji.
- Niezgodność nazwy lub kontraktu z rzeczywistym zachowaniem jest dowodem narracyjnym, nawet jeśli równocześnie wskazuje błąd poprawności. W \`reason\` nazwij wyłącznie obserwowalną niezgodność komunikacji.
- Nie wnioskuj, że refaktor poprawi zachowanie. \`suggested_action\` może proponować tylko najmniejszą zmianę usuwającą wykazany koszt poznawczy, z zachowaniem istniejącego kontraktu działania.
- Długość funkcji, liczba branchy, nesting i Cognitive Complexity wskazują miejsca do inspekcji; bez zlokalizowanego przykładu utraty znaczenia, ukrytego przepływu albo zbędnej nawigacji nie uzasadniają negatywnego werdyktu ani refaktoru.
- Nie zalecaj polimorfizmu, helpera, warstwy ani nowego typu tylko dlatego, że jest to znany wzorzec. Zalecenie musi usuwać konkretną, zacytowaną niejednoznaczność lub powtarzaną wiedzę.

## Dozwolone źródła i routing kontroli

W ramach \`allowed_sources\` źródłami właściwymi dla tej domeny są:

1. oceniany kod wraz z sygnaturami, typami, komentarzami i dokładnymi lokalizacjami;
2. deklaracje implementowanych interfejsów, protokołów, klas bazowych i publicznych kontraktów API;
3. bezpośrednie callsite'y i definicje helperów w zadeklarowanym zakresie review;
4. testy kontraktowe, przykłady użycia, glossary/ADR/specyfikacja domenowa i dokumentacja API, jeśli zostały jawnie przekazane;
5. manifest zakresu, mapa symboli/call graph, wyniki typecheckera lub kompilatora, wyniki zapytań AST oraz raport metryki z konfiguracją narzędzia, jeśli harness przekazał je jako \`deterministic_evidence\`.

Nie zakładaj znaczenia terminu z wiedzy ogólnej, nazwy repozytorium ani nieudostępnionych callerów. Jeżeli werdykt zależy od tego, czy nazwa jest narzucona przez protokół, czy branch powtarza się poza widocznym zakresem, potrzebna deklaracja albo mapa callsite'ów musi znajdować się w dozwolonych źródłach; w przeciwnym razie zastosuj kontrakt braku kontekstu ze wspólnego include.

Kontrole deterministyczne ustalają tylko fakty syntaktyczne lub relacyjne: wystąpienia symboli, relację override/implement, call graph, liczbę i lokalizację branchy oraz wartość metryki. Harness lub wskazane narzędzie jest ich właścicielem. Interpretacja znaczenia, kosztu nawigacji i adekwatności modelu pozostaje oceną według poniższych warunków. Wynik metryki ani heurystyki nie może zastąpić wymaganego dowodu semantycznego.

## Grupy wywołań

Harness przekazuje każdą z poniższych grup jako osobne, semantycznie spójne wywołanie. Nie łącz grup w jedno wywołanie i nie dziel pojedynczego kryterium. Każda grupa ma najwyżej dziesięć kryteriów.

### Grupa C — wartości, efekty, branching i metryki

\`\`\`yaml
criteria:
    - id: COG-1
      name: Ujawnienie kategorii efektu ubocznego
      description: Powierzchnia użycia operacji ujawnia jedną wskazaną kategorię wykonywanego efektu zewnętrznego.
      applies_when: 'Harness wskazuje dokładnie jedno zlokalizowane wystąpienie efektu należącego do jednej kategorii: I/O, mutacja stanu widocznego poza lokalnym zakresem, publikacja zdarzenia albo rejestracja callbacka.'
      pass_when:
          - Nazwa, typ, sygnatura, adnotacja efektu lub bezpośredni kontrakt przy wywołaniu identyfikuje tę samą kategorię efektu co wskazane wystąpienie.
      fail_when:
          - Powierzchnia użycia nie ujawnia wskazanej kategorii efektu.
          - Powierzchnia użycia komunikuje czystość albo inną kategorię efektu niż wskazane wystąpienie.
      exceptions:
          - Efekt wymagany przez udostępniony lifecycle frameworka lub protokół może wynikać z deklaracji callbacka, jeśli relacja implement/override jest widoczna callerowi.
          - Lokalna mutacja świeżo utworzonej wartości, która nie ucieka przed zwróceniem, nie jest efektem zewnętrznym dla tego kryterium.
      severity: major
      evidence_required:
          - Lokalizacja jednego wskazanego efektu oraz sygnatura, nazwa i lokalizacja wywołania operacji.
          - Deklaracja lifecycle'u lub protokołu, jeśli ma uzasadniać wyjątek.
          - Analiza ucieczki lub zasięgu wartości, jeśli wyjątek lokalnej mutacji rozstrzyga werdykt.
      deterministic_check: Harnessowy typechecker lub analiza efektów/wywołań ustala wystąpienie i kategorię efektu, relację override albo ucieczkę wartości; judge ocenia wyłącznie ujawnienie tej kategorii na powierzchni użycia.

    - id: COG-2A
      name: Rola semantyczna wartości
      description: Nazwa wraz z typem jednoznacznie komunikuje jedną wskazaną rolę semantyczną wartości.
      applies_when: Harness wskazuje dokładnie jedną wartość prymitywną albo jedną z kilku wartości o tym samym typie oraz operację, w której jej rola semantyczna wpływa na porównanie, konwersję, arytmetykę lub wywołanie.
      pass_when:
          - Wskazana rola wartości wynika z jej nazwy, typu domenowego, pola struktury albo nazwanego parametru w miejscu ocenianej operacji.
      fail_when:
          - Roli wskazanej wartości nie da się ustalić z nazwy, typu, pola struktury ani nazwanego parametru w miejscu operacji bez śledzenia przypisań; obecność drugiej możliwej roli wzmacnia dowód, ale nie jest wymagana.
          - Nazwa lub typ komunikuje inną rolę niż rola wskazanej wartości w ocenianej operacji.
      exceptions:
          - Konwencjonalny lokalny indeks, akumulator lub wynik bezpośrednio nazwanej operacji jest dopuszczalny, jeśli zakres jest krótki i w tym zakresie nie istnieje druga możliwa rola.
      severity: minor
      evidence_required:
          - Deklaracja wskazanej wartości i lokalizacja operacji, w której jej rola ma znaczenie.
          - Definicja typu lub kontrakt roli, jeśli ma rozstrzygać jednoznaczność.
          - Lokalizacja drugiej możliwej roli w tym samym zakresie, gdy naruszenie dotyczy nazwy ogólnej.
      deterministic_check: Harnessowy typechecker dostarcza rozwinięty typ wskazanej wartości i mapowanie argumentu do parametru; interpretacja jednej roli semantycznej pozostaje oceną judge'a.

    - id: COG-2B
      name: Jednostka miary wartości
      description: Nazwa wraz z typem jednoznacznie komunikuje jedną wskazaną jednostkę miary wartości.
      applies_when: Harness wskazuje dokładnie jedną wartość liczbową lub ilościową oraz operację, w której jej jednostka wpływa na konwersję, porównanie, arytmetykę albo wywołanie.
      pass_when:
          - Wskazana jednostka jest zakodowana w typie, nazwie lub sufiksie wartości albo w zlokalizowanym kontrakcie przy granicy ocenianej operacji.
      fail_when:
          - Jednostki wskazanej wartości nie da się ustalić z typu, nazwy ani lokalnego kontraktu przy ocenianej operacji.
          - Nazwa, typ lub lokalny kontrakt komunikuje inną jednostkę niż jednostka użyta przez ocenianą operację.
      exceptions:
          - Silny typ jednostki nie wymaga powtarzania jednostki w nazwie zmiennej.
          - Bezpośredni wynik operacji jawnie nazwanej jednostką może zachować krótką nazwę w krótkim zakresie, jeśli nie jest mieszany z inną jednostką.
      severity: minor
      evidence_required:
          - Deklaracja wskazanej wartości i lokalizacja operacji, w której jej jednostka ma znaczenie.
          - Definicja typu, kontrakt granicy albo sygnatura nazwanej konwersji ustalająca wskazaną jednostkę.
          - Lokalizacja komunikowanej i używanej jednostki, gdy naruszenie dotyczy ich niezgodności.
      deterministic_check: Harnessowy typechecker dostarcza rozwinięty typ wskazanej wartości i sygnaturę ocenianej operacji lub konwersji; judge ocenia wyłącznie czy wskazana jednostka jest komunikowana jednoznacznie.

    - id: FLOW-1
      name: Lokalność decyzji branchingowej
      description: Decyzja oparta na stabilnym discriminatorze jest utrzymywana przy jednym właścicielu w zadeklarowanym zakresie.
      applies_when: W dozwolonym zakresie występuje branch lub dispatch na statusie, rodzaju, trybie, stanie albo fladze reprezentującej stabilne pojęcie.
      pass_when:
          - Reguła wyboru jest zlokalizowana przy właścicielu pojęcia, w jednym dispatcherze albo w jawnej tabeli przejść.
          - Pojedynczy lokalny branch nie powiela tej samej reguły w innym widocznym callerze.
      fail_when:
          - Ta sama reguła wyboru na tym samym discriminatorze jest zlokalizowana w co najmniej dwóch niezależnych callerach w zadeklarowanym zakresie.
          - Zmiana jednego wariantu wymagałaby edycji co najmniej dwóch wskazanych lokalizacji zawierających tę samą decyzję.
      exceptions:
          - Rozdzielne warstwy mogą branchować na tym samym discriminatorze, jeśli każda realizuje inną, jawnie nazwaną politykę.
          - Jawna maszyna stanów lub tabela dispatchu jest właściwym właścicielem wielu branchy, gdy przejścia są zgromadzone w jednym modelu.
          - Jeden lokalny stabilny \`if\` nie wymaga polimorfizmu ani extraction.
      severity: minor
      evidence_required:
          - Wszystkie lokalizacje branchy objęte twierdzeniem o duplikacji i manifest zadeklarowanego zakresu.
          - Cytowane warunki lub warianty pokazujące, że powtarza się ta sama reguła, a nie tylko ten sam typ.
      deterministic_check: Harnessowe zapytanie AST lub indeks referencji wylicza branche na wskazanym discriminatorze w zadeklarowanym zakresie; judge porównuje znaczenie polityk.

    - id: METRIC-1
      name: Metryka jako sygnał, nie werdykt
      description: Liczbowa metryka czytelności służy wyłącznie do wskazania miejsca, a ocena opiera się na obserwowalnym koszcie w kodzie.
      applies_when: Artefakt review, uzasadnienie zmiany albo rekomendacja używa Cognitive Complexity, nestingu, branch count, długości funkcji lub podobnego progu do uzasadnienia negatywnego werdyktu albo refaktoru.
      pass_when:
          - Cytowana metryka jest jedynie sygnałem hotspotu, a niezależny dowód lokalizuje konkretną niejednoznaczność, ukryty przepływ, zmianę poziomu abstrakcji albo zbędny hop stanowiący podstawę werdyktu lub zmiany.
      fail_when:
          - Negatywny werdykt lub refaktor jest uzasadniony wyłącznie wartością albo przekroczeniem progu, bez zlokalizowanego dowodu semantycznego.
      exceptions:
          - Twardy próg narzucony przez udostępnioną politykę narzędziową może być raportowany jako osobne naruszenie polityki, lecz nie staje się przez to dowodem tego kryterium narracyjnego.
      severity: minor
      evidence_required:
          - Lokalizacja twierdzenia metrycznego lub rekomendacji oraz wszystkie podane przez nie dowody semantyczne.
          - Lokalizacja kosztu, który zmiana ma usunąć, albo lokalizacje dodatkowych hopów/ukrytego przepływu, które zmiana wprowadza.
          - Raport narzędzia i konfiguracja tylko wtedy, gdy werdykt zależy od prawdziwości cytowanej wartości lub progu.
      deterministic_check: Właściciel wskazanego narzędzia metrycznego odtwarza wartość i próg, gdy ich poprawność jest sporna; wynik potwierdza liczbę, nigdy ocenę narracji. Do stwierdzenia, że metryka jest jedynym uzasadnieniem, raport liczbowy nie jest wymagany.
\`\`\`

## Łączenie wyników

Nie wyliczaj punktów, średniej ani łącznego „poziomu cognitive load”. Po zakończeniu osobnych wywołań harness zachowuje każdy wynik kryterium dokładnie raz i wyznacza jeden \`overall_verdict\`, \`automation_decision\` oraz eskalację zgodnie ze wspólnym include. Nie dodawaj pól spoza wspólnego schematu. W polu \`reason\` każdego elementu \`criterion_results\` odwołuj się wyłącznie do dowodów jego kryterium; wspólna obserwacja wymaga osobnego uzasadnienia dla każdego ID.

## Kotwice kalibracyjne

1. **Kod techniczny bez historii domenowej — \`PASS\` dla \`LANG-2\`, \`NOT_APPLICABLE\` dla \`LANG-1\`.** \`decodeFrame(bytes) -> Frame\` jednoznacznie nazywa dekodowanie bajtów na granicy formatu ramki, a bezpośrednie operacje implementacji potwierdzają tę transformację. Nie wymaga podmiotu ani reguły biznesowej; widoczność efektów jest oceniana osobno przez \`COG-1\`.
6. **Brak efektów lub metryki — \`NOT_APPLICABLE\`.** Czysta transformacja bez I/O i mutacji nie podlega \`COG-1\`; review bez twierdzenia metrycznego nie podlega \`METRIC-1\`. Nie przyznawaj im wyniku pozytywnego za sam brak przedmiotu oceny.
7. **Zarzut oparty tylko na metryce — \`FAIL\` dla \`METRIC-1\`, bez przenoszenia werdyktu.** „Cognitive Complexity = 18, więc rozbij funkcję” bez lokalizacji utraconego znaczenia lub przepływu narusza obsługę metryki. Sama liczba nie powoduje negatywnego wyniku \`NARR-3\`, \`NARR-4\` ani \`NARR-5\`; każde z nich potrzebuje własnego dowodu.`,
} satisfies JudgeDefinition;
