import type { JudgeDefinition } from "../types";

export const storyNavigationJudge = {
	id: "narrative-cognition/story-navigation",
	judgeType: "narrative-cognition",
	rubricVersion: "readable-code-narrative-cognition/2.1.0",
	criterionIds: ["NARR-1A", "NARR-1B", "NARR-2", "NARR-3", "NARR-4", "NARR-5"],
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

### Grupa B — narracja, refinement i nawigacja

\`\`\`yaml
criteria:
    - id: NARR-1A
      name: Kontrakt powierzchni entry pointu
      description: Powierzchnia entry pointu wiernie komunikuje jedną wskazaną relację wejście–rezultat lub wejście–postcondition.
      applies_when: Harness wskazuje dokładnie jeden entry point oraz dokładnie jedną nazwaną parę obejmującą akceptowane wejście i rezultat, wariant błędu albo inny postcondition widoczny w dozwolonych źródłach.
      pass_when:
          - Nazwa, sygnatura, zwracany typ lub bezpośredni kontrakt entry pointu jednoznacznie komunikuje wskazaną parę wejście–rezultat/postcondition i zgadza się z dostarczonym faktem o rezultacie implementacji.
      fail_when:
          - Wskazanej pary wejście–rezultat/postcondition nie można ustalić z powierzchni entry pointu bez otwarcia helpera.
          - Powierzchnia entry pointu deklaruje dla wskazanego wejścia inny rezultat, wariant błędu albo postcondition niż dostarczony fakt o implementacji.
      exceptions:
          - Maszyna stanów może komunikować tę parę jako \`(state, event) -> next state/effect\` w jawnej tabeli albo typie przejścia.
          - Pipeline może komunikować rezultat przez typ kompozycji zamiast przez imperatywną instrukcję \`return\`.
      severity: major
      evidence_required:
          - Nazwa, sygnatura lub bezpośredni kontrakt entry pointu i dokładna lokalizacja wskazanej pary wejście–rezultat/postcondition.
          - Harnessowy wynik typecheckera rozwijający typ wejścia i rezultatu oraz wynik zapytania AST wskazujący zwracane wyrażenie, wariant albo przejście ustalające wskazany rezultat implementacji.
      deterministic_check: Harness jest właścicielem typecheckera i zapytania AST ustalających typy wejścia/rezultatu oraz zlokalizowany fakt o zwracanym wariancie lub przejściu; judge ocenia wyłącznie zgodność semantyczną powierzchni z tą jedną wskazaną parą.

    - id: NARR-1B
      name: Narracja kolejności kroków entry pointu
      description: Powierzchnia jednego wskazanego przebiegu entry pointu ujawnia kolejność jego bezpośrednich istotnych kroków.
      applies_when: Harness wskazuje dokładnie jeden entry point i jeden nazwany przebieg, przejście albo kompozycję zawierającą co najmniej dwa bezpośrednie istotne kroki.
      pass_when:
          - Nazwy i struktura bezpośrednich kroków pozwalają odtworzyć ich kolejność bez otwierania implementacji helperów, a kolejność zgadza się z path-sensitive wynikiem CFG albo jawnym porządkiem kompozycji dla wskazanego przebiegu.
      fail_when:
          - Powierzchnia wskazanego przebiegu nie ujawnia kolejności kroków, nawet jeśli ich pojedyncze nazwy komunikują role.
          - Co najmniej jeden bezpośredni krok ma nazwę niekomunikującą jego roli, przez co kolejności narracyjnej nie można odtworzyć bez otwarcia helpera.
          - Kolejność komunikowana przez nazwy, kompozycję albo tabelę jest inna niż kolejność wykonania ustalona przez path-sensitive CFG lub semantykę jawnej kompozycji.
      exceptions:
          - Pipeline nie musi eksponować imperatywnej sekwencji, jeśli kolejność wskazanego przebiegu jest jawna w kompozycji.
          - Dla maszyny stanów oceniaj tylko wskazane przejście zawierające uporządkowane kroki; brak takiej sekwencji daje \`NOT_APPLICABLE\`, a nie wymóg pojedynczego happy path.
      severity: major
      evidence_required:
          - Pełne bezpośrednie ciało wskazanego przebiegu, przejścia albo kompozycji oraz lokalizacje ocenianych kroków.
          - Harnessowy path-sensitive wynik CFG albo manifest jawnej kompozycji wyliczający kroki i kolejność wykonania dla dokładnie tego przebiegu.
      deterministic_check: Harness jest właścicielem path-sensitive analizy CFG albo parsera jawnej kompozycji; porządek syntaktyczny AST bez analizy sterowania nie jest dowodem kolejności wykonania.

    - id: NARR-2
      name: Refinement helpera
      description: Helper rozwija dokładnie ten krok, który jego nazwa przedstawia callerowi.
      applies_when: Oceniany przepływ wywołuje co najmniej jeden owned helper reprezentujący nazwany krok.
      pass_when:
          - Wszystkie istotne operacje helpera są szczegółami, invariantami lub polityką należącą do kroku nazwanego w callerze.
          - Caller nie musi znać kolejności wewnętrznych operacji helpera, aby rozumieć własny poziom narracji.
      fail_when:
          - Helper wprowadza niezależną fazę, decyzję lub wynik, którego jego nazwa nie zapowiada i który należy do poziomu narracji callera.
          - Helper nazwany jako jeden krok faktycznie orkiestruje kilka równorzędnych kroków ukrytych przed callerem.
      exceptions:
          - Helper może wykonywać kilka operacji, jeśli razem realizują jeden nazwany invariant, atomową transakcję lub granicę techniczną.
          - Brak helpera nie jest naruszeniem; extraction nie jest celem samym w sobie.
      severity: minor
      evidence_required:
          - Lokalizacja wywołania i pełna definicja helpera.
          - Lokalizacje operacji uznanych za niezależną fazę, decyzję lub wspólny invariant.
      deterministic_check: Harnessowy call graph może potwierdzić relację caller-helper; nie ocenia przynależności semantycznej operacji.

    - id: NARR-3
      name: Jednolity poziom abstrakcji
      description: Jedna funkcja utrzymuje dominujący poziom decyzji albo wykonania potrzebny do jej nazwanej odpowiedzialności.
      applies_when: Ciało ocenianej funkcji zawiera co najmniej dwa istotne kroki lub operacje.
      pass_when:
          - Istotne statementy należą do jednego poziomu decyzji lub wykonania wskazanego przez nazwaną odpowiedzialność; inline detal niższego poziomu wyraża lokalny invariant albo atomową operację tej odpowiedzialności.
      fail_when:
          - Funkcja przeplata kroki jednego poziomu z dowolnym detalem implementacyjnym wymagającym zmiany modelu pojęciowego, który nie wyraża lokalnego invariantu ani atomowej operacji tej odpowiedzialności; parsowanie, kodowanie, formatowanie i transport są przykładami, nie zamkniętą listą.
          - Funkcja na poziomie detalu podejmuje niezapowiedzianą decyzję polityki należącą do wyższego poziomu.
      exceptions:
          - Handler przejścia stanu może obok decyzji przypisać następny stan lub wyemitować jawnie nazwany efekt, jeśli razem stanowią jedno przejście.
          - Krótka spójna transformacja nie wymaga helperów tylko po to, by statementy miały identyczny kształt.
      severity: minor
      evidence_required:
          - Pełne ciało funkcji z lokalizacjami co najmniej dwóch porównywanych kroków.
          - Nazwa lub kontrakt funkcji ustalający jej odpowiedzialność.
      deterministic_check: null

    - id: NARR-4
      name: Proporcjonalny koszt nawigacji
      description: Każdy skok potrzebny do odtworzenia głównego przepływu wnosi nazwany kontrakt, invariant albo granicę.
      applies_when: Zrozumienie głównego przepływu wymaga przejścia z entry pointu do co najmniej jednej definicji, aliasu lub kontraktu.
      pass_when:
          - Każdy wymagany skok dodaje nazwany kontrakt, invariant, politykę lub granicę architektoniczną, których ukrycie upraszcza poziom callera.
          - Główny przepływ można odtworzyć bez przechodzenia przez wrappery lub aliasy, które jedynie przekazują te same argumenty i rezultat bez dodania znaczenia.
      fail_when:
          - Co najmniej jeden skok niezbędny do ustalenia konkretnego faktu głównego przepływu nie dodaje nazwy odpowiedzialności, kontraktu, invariantu ani wymaganej granicy, niezależnie od długości łańcucha.
          - Znaczenie jednego kroku jest rozproszone między aliasami lub wrapperami tak, że żadna z ich powierzchni nie deklaruje ustalanego faktu.
      exceptions:
          - Skoki wymagane przez udostępniony framework, warstwę port-adapter, granicę procesu lub stabilne publiczne API są uzasadnione, jeśli granica jest widoczna w nazwie albo typie.
          - Zero skoków nie jest celem i nie uzasadnia scalania odpowiedzialności.
      severity: minor
      evidence_required:
          - Entry point oraz każda lokalizacja w zakwestionowanym łańcuchu nawigacji.
          - Fakt głównego przepływu, którego ustalenie wymaga tego łańcucha.
          - Deklaracja granicy frameworka lub API, jeśli ma uzasadniać wyjątek.
      deterministic_check: Harnessowy call graph lub mapa definicji wylicza hop'y i aliasy w przekazanym zakresie; nie rozstrzyga, czy wnoszą znaczenie.

    - id: NARR-5
      name: Widoczność głównego przepływu
      description: Struktura kodu pozwala prześledzić główne przejścia bez mieszania ich z detalami alternatyw i obsługi błędów.
      applies_when: Oceniane ciało zawiera sekwencję, rozgałęzienie, pipeline albo przejścia stanów reprezentujące przepływ operacji.
      pass_when:
          - Główne przejścia dają się wskazać w kolejności kodu, kompozycji pipeline'u albo jawnej relacji stan-zdarzenie-przejście.
          - Alternatywy i błędy są lokalnie nazwane, zwracane albo odseparowane strukturą bez ukrywania warunków wejścia do kolejnego głównego kroku.
      fail_when:
          - Co najmniej jeden główny krok jest zagnieżdżony wewnątrz niepowiązanej obsługi alternatywy lub błędu, a jego warunek wykonania trzeba odtworzyć z rozproszonych branchy.
          - Kolejność głównych przejść w pipeline'ie lub maszynie stanów nie jest dostępna w kompozycji, tabeli przejść ani nazwach handlerów i wymaga śledzenia niejawnych callbacków.
      exceptions:
          - Exhaustive match, wynikowy pipeline i jawna maszyna stanów nie muszą wyróżniać jednej ścieżki jako nadrzędnej, jeśli wiernie pokazują wszystkie równorzędne przejścia.
          - Guard clauses są dopuszczalne, gdy kończą lokalną alternatywę i pozostawiają dalszą sekwencję widoczną.
      severity: major
      evidence_required:
          - Pełne ciało przepływu lub kompletna przekazana tabela przejść/kompozycja pipeline'u.
          - Lokalizacje głównych kroków oraz branchy, callbacków lub obsługi błędów wpływających na ich kolejność.
      deterministic_check: Harnessowa analiza AST może wskazać nesting i callbacki jako miejsca inspekcji; nie może samodzielnie wydać werdyktu.
\`\`\`

## Łączenie wyników

Nie wyliczaj punktów, średniej ani łącznego „poziomu cognitive load”. Po zakończeniu osobnych wywołań harness zachowuje każdy wynik kryterium dokładnie raz i wyznacza jeden \`overall_verdict\`, \`automation_decision\` oraz eskalację zgodnie ze wspólnym include. Nie dodawaj pól spoza wspólnego schematu. W polu \`reason\` każdego elementu \`criterion_results\` odwołuj się wyłącznie do dowodów jego kryterium; wspólna obserwacja wymaga osobnego uzasadnienia dla każdego ID.

## Kotwice kalibracyjne

4. **Celowa maszyna stanów lub pipeline — granica \`NARR-1A\`, \`NARR-1B\` i \`NARR-5\`.** Jawna tabela \`(state, event) -> transition\` komunikuje wskazany rezultat przejścia i daje \`PASS\` dla \`NARR-1A\`; jawna struktura przejść może dać \`PASS\` dla \`NARR-5\`. \`NARR-1B\` ma \`PASS\` tylko dla wskazanego przejścia lub kompozycji z co najmniej dwoma uporządkowanymi krokami; bez takiej sekwencji ma \`NOT_APPLICABLE\`. Brak jednego happy path lub pattern matching nie są naruszeniem.
7. **Zarzut oparty tylko na metryce — \`FAIL\` dla \`METRIC-1\`, bez przenoszenia werdyktu.** „Cognitive Complexity = 18, więc rozbij funkcję” bez lokalizacji utraconego znaczenia lub przepływu narusza obsługę metryki. Sama liczba nie powoduje negatywnego wyniku \`NARR-3\`, \`NARR-4\` ani \`NARR-5\`; każde z nich potrzebuje własnego dowodu.
8. **Uzasadnione lokalne rozwinięcie — \`PASS\` dla \`NARR-2\` i \`NARR-3\`.** Helper \`verifySignature\` wykonuje dekodowanie klucza, wyliczenie skrótu i porównanie w stałym czasie jako jeden invariant weryfikacji. Te detale reprezentacji pozostają razem pod prawdziwą nazwą kroku, więc caller utrzymuje poziom orkiestracji; kilka operacji wewnątrz helpera nie tworzy samo w sobie mieszania poziomów.
9. **Sparowany kontrprzykład mieszania poziomów — \`FAIL\` dla \`NARR-3\`.** \`acceptRequest\` wywołuje \`parseRequest\`, następnie inline wykonuje \`Base64.decode(key)\`, \`SHA256.digest(payload)\` i \`constantTimeEquals\`, po czym wywołuje \`persistRequest\`. Dokładnie te trzy statementy reprezentacji kryptograficznej między równorzędnymi krokami orkiestracji wymuszają zmianę modelu pojęciowego i nie są lokalnym invariantem samego \`acceptRequest\`; w odróżnieniu od kotwicy 8 uzasadniają wydzielenie prawdziwie nazwanego kroku \`verifySignature\`. Sama liczba statementów nie uzasadnia \`FAIL\`.`,
} satisfies JudgeDefinition;
