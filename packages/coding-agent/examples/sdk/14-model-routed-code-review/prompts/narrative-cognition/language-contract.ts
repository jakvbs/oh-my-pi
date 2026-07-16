import type { JudgeDefinition } from "../types";

export const languageContractJudge = {
	id: "narrative-cognition/language-contract",
	judgeType: "narrative-cognition",
	rubricVersion: "readable-code-narrative-cognition/2.1.0",
	criterionIds: ["LANG-1", "LANG-2", "LANG-3"],
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

### Grupa A — język i kontrakt nazw

\`\`\`yaml
criteria:
    - id: LANG-1
      name: Nazwy kontraktu domenowego
      description: Jeden wskazany owned symbol zachowania domenowego komunikuje pojęcie i decyzję realizowaną przez kod.
      applies_when: Harness wskazuje jeden owned symbol realizujący regułę, decyzję, zdarzenie albo operację opisaną przekazanym kontraktem domenowym.
      pass_when:
          - Nazwa symbolu wraz z typem właściciela komunikuje zlokalizowane zachowanie zgodnie z kontraktem i obserwowalną decyzją implementacji.
      fail_when:
          - Nazwa przypisuje zachowaniu inne pojęcie lub decyzję niż wskazują kontrakt i implementacja.
          - Nazwa jest tak ogólna, że jej powierzchnia nie komunikuje zlokalizowanego zachowania i trzeba wejść do implementacji, aby je ustalić; sąsiedni symbol nie jest wymagany.
      exceptions:
          - Nazwa elementu narzucona przez udostępniony protokół lub interfejs nie narusza kryterium, jeśli owned kontekst typu lub bezpośrednie kroki ujawniają właściwe znaczenie.
          - Termin techniczny nie musi być zastąpiony metaforą domenową, jeśli oceniany fragment nie realizuje reguły domenowej.
      severity: major
      evidence_required:
          - Lokalizacja owned symbolu i co najmniej jedna lokalizacja zachowania, które symbol nazywa.
          - Lokalizacja przekazanego kontraktu domenowego albo jawny fakt, że klasyfikacja jako domenowa wynika z samego artefaktu.
          - Deklaracja protokołu lub interfejsu, jeżeli wyjątek nazwy narzuconej ma rozstrzygać werdykt.
      deterministic_check: Harness/typechecker dostarcza relację implement/override dla ocenianego symbolu; kontrola rozstrzyga wyłącznie, czy nazwa jest narzucona.

    - id: LANG-2
      name: Nazwa transformacji lub granicy technicznej
      description: Owned nazwa kodu technicznego jednoznacznie komunikuje wykonywaną transformację albo chronioną granicę.
      applies_when: W dozwolonych źródłach oceniany owned entry point wykonuje techniczną transformację, adaptację, serializację, walidację, transport albo ochronę granicy bez własnej reguły domenowej.
      pass_when:
          - Nazwa entry pointu, interpretowana wraz z typem właściciela, sygnaturą lub lokalnym kontraktem, identyfikuje konkretną transformację albo granicę zgodną z bezpośrednimi operacjami implementacji.
      fail_when:
          - Owned nazwa typu \`process\`, \`handle\`, \`manage\` lub \`execute\` wraz z typem właściciela, sygnaturą i kontraktem nie komunikuje konkretnej transformacji albo granicy; symbol porównawczy nie jest wymagany.
          - Nazwa deklaruje inną transformację albo granicę niż pokazują zlokalizowane operacje implementacji.
      exceptions:
          - Element nazwany przez udostępniony standard, framework lub protokół może zachować nazwę ogólną, gdy typ właściciela i deklaracja protokołu jednoznacznie określają transformację albo granicę.
          - Adapter, parser i mapper nie potrzebują sztucznego słownictwa domenowego, jeśli ich transformacja albo granica techniczna jest jednoznaczna.
      severity: major
      evidence_required:
          - Nazwa, sygnatura i lokalizacja entry pointu oraz lokalizacje bezpośrednich operacji ustalających transformację albo granicę.
          - Sąsiedni symbol porównawczy, gdy naruszenie opiera się na niemożności odróżnienia operacji.
          - Deklaracja standardu, frameworka lub protokołu, gdy wyjątek nazwy narzuconej ma zastosowanie.
      deterministic_check: Harness/typechecker dostarcza relację implement/override oraz rozwinięte typy wejścia i wyjścia wyłącznie jako fakty o powierzchni operacji; judge porównuje semantykę nazwy z transformacją albo granicą.

    - id: LANG-3
      name: Spójność terminologii
      description: Ten sam termin zachowuje jedno znaczenie, a jedno pojęcie nie wymaga niejawnego tłumaczenia między udostępnionymi źródłami.
      applies_when: To samo pojęcie lub termin występuje w co najmniej dwóch lokalizacjach ocenianego kodu albo w kodzie i innym dozwolonym źródle.
      pass_when:
          - Każde zacytowane użycie terminu oznacza ten sam stan, obiekt, czynność lub jednostkę w ocenianym zakresie.
          - Różne nazwy tego samego pojęcia mają jawne mapowanie w typie, granicy translacji lub przekazanym glossary.
      fail_when:
          - Ten sam termin oznacza dwa różne stany, obiekty, działania lub jednostki bez jawnego rozróżnienia kontekstu.
          - Jedno pojęcie zmienia nazwę między kodem, kontraktem i testami bez zlokalizowanej granicy translacji, przez co śledzenie decyzji wymaga zgadywania mapowania.
      exceptions:
          - Lokalna krótka nazwa o konwencjonalnym zasięgu, taka jak indeks pętli, jest dopuszczalna, jeśli nie reprezentuje pojęcia kontraktowego.
          - Jawny anti-corruption layer może celowo mapować dwa słowniki, jeśli mapowanie jest widoczne przy granicy.
      severity: major
      evidence_required:
          - Co najmniej dwie dokładne lokalizacje porównywanych użyć.
          - Definicja typu, mapowanie albo glossary, jeśli ma rozstrzygać, czy nazwy są równoważne.
      deterministic_check: Harnessowy indeks symboli lub wyszukiwanie tokenów może dostarczyć listę wystąpień; judge rozstrzyga ich znaczenie z kontekstu.
\`\`\`

## Łączenie wyników

Nie wyliczaj punktów, średniej ani łącznego „poziomu cognitive load”. Po zakończeniu osobnych wywołań harness zachowuje każdy wynik kryterium dokładnie raz i wyznacza jeden \`overall_verdict\`, \`automation_decision\` oraz eskalację zgodnie ze wspólnym include. Nie dodawaj pól spoza wspólnego schematu. W polu \`reason\` każdego elementu \`criterion_results\` odwołuj się wyłącznie do dowodów jego kryterium; wspólna obserwacja wymaga osobnego uzasadnienia dla każdego ID.

## Kotwice kalibracyjne

1. **Kod techniczny bez historii domenowej — \`PASS\` dla \`LANG-2\`, \`NOT_APPLICABLE\` dla \`LANG-1\`.** \`decodeFrame(bytes) -> Frame\` jednoznacznie nazywa dekodowanie bajtów na granicy formatu ramki, a bezpośrednie operacje implementacji potwierdzają tę transformację. Nie wymaga podmiotu ani reguły biznesowej; widoczność efektów jest oceniana osobno przez \`COG-1\`.`,
} satisfies JudgeDefinition;
