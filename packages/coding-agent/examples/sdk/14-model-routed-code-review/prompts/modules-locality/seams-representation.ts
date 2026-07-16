import type { JudgeDefinition } from "../types";

export const seamsRepresentationJudge = {
	id: "modules-locality/seams-representation",
	judgeType: "modules-locality",
	rubricVersion: "readable-code-modules-locality/2.0.0",
	criterionIds: [
		"SEAM-REAL-VARIATION",
		"ADAPTER-BOUNDARY-ISOLATION",
		"DATA-CANONICAL-REPRESENTATION",
		"DATA-VALUE-OBJECT-INVARIANT",
		"ABSTRACTION-CALLER-KNOWLEDGE",
		"ABSTRACTION-SHARED-CONTRACT",
	],
	prompt: `# Judge modułów, abstrakcji i lokalności zmian

Rubryka LLM-as-a-Judge do oceny, czy moduły ukrywają wiedzę, skupiają decyzje i ograniczają zasięg wiarygodnych zmian bez dokładania abstrakcji na hipotetyczną przyszłość.


rubric_version: "modules-locality/2.0.0"

## Aktywacja i granice

Użyj rubryki, gdy zmiana dodaje lub modyfikuje moduł, interfejs, helper, warstwę, seam, adapter, DTO, mapper albo value object; przenosi regułę między właścicielem i callerami; lub uzasadnia refaktoryzację depth, leverage, lokalnością, testowalnością bądź wymiennością. Uruchamiaj tylko grupy dotyczące zmienionego artefaktu i jawnego celu review. Jedno wywołanie judge'a obejmuje jedną grupę poniżej i nie więcej niż 10 kryteriów.

Nie wymagaj nowej warstwy, strategii, interfejsu ani value objectu tylko dlatego, że mogą kiedyś pomóc. Lokalny, stabilny warunek, bez powtórzonej wiedzy i bez wiarygodnej osi zmian, jest poprawną prostszą konstrukcją. Duplikacja tekstu, liczba plików, liczba wywołań oraz sam rozmiar interfejsu wskazują miejsca do inspekcji, lecz bez wykazanego kosztu semantycznego nie uzasadniają refaktoryzacji ani \`FAIL\`.

## Dozwolone źródła domenowe

W obrębie \`allowed_sources\` korzystaj tylko z:

- diffu i pełnych definicji zmienionych modułów, interfejsów, reprezentacji oraz bezpośrednich callerów;
- deklaracji publicznych kontraktów, schematów wire/persistence i dokumentacji użytych bibliotek lub vendorów;
- testów opisujących zachowanie na granicy, invarianty, polityki oraz istniejące warianty;
- jawnych wymagań, issue, ADR lub opisu zmiany, które nazywają prawdopodobną zmianę, wariant, granicę albo wymienność;
- przekazanego przez harness call graphu, raportu referencji, wyników kompilatora/schema validatora i wyników sond zmian.

Komentarz o „elastyczności”, nazwa \`Interface\` albo możliwość napisania mocka nie są dowodem realnej osi zmienności. Test może potwierdzać kontrakt, lecz samo ułatwienie mockowania nie ustanawia granicy domenowej. Gdy wymagany caller, kontrakt granicy lub treść sondy nie znajduje się w \`allowed_sources\`, zwróć \`INSUFFICIENT_CONTEXT\` dla zależnego kryterium zamiast dopowiadać architekturę.

## Routing kontroli deterministycznych

Kontrole wymienione w \`deterministic_check\` wykonuje harness, nie judge. Raport musi podawać lokalizacje i kategorię każdego trafienia, a dla porównania także baseline, jeśli jest dostępny. Liczniki dotkniętych plików, właścicieli, callsite'ów, reprezentacji, branchy, mapowań i testów są wyłącznie dowodem do interpretacji; nie istnieje uniwersalny próg automatycznie powodujący \`FAIL\`. Wygenerowany kod licz oddzielnie i nie traktuj wielu wygenerowanych trafień jako wielu właścicieli, jeśli mają jedno kanoniczne źródło.

Najpierw sprawdź \`applies_when\`. Brak jawnej sondy spełniającej warunek zastosowania oznacza \`NOT_APPLICABLE\` dla kryterium \`PROBE-*\`, a nie \`INSUFFICIENT_CONTEXT\`. Dopiero gdy kryterium ma zastosowanie, lecz harness nie przekazał wymaganej symulacji, wyniku wyszukiwania albo innego dowodu, zwróć \`INSUFFICIENT_CONTEXT\`; dotyczy to także kryterium \`MOD-*\`, którego \`applies_when\` jest spełnione. Judge rozstrzyga znaczenie znalezionych miejsc: czy zawierają tę samą wiedzę, czy należą do niezależnych kontekstów oraz czy jawny wyjątek ma zastosowanie. Jedno znalezisko może być dowodem w kilku kryteriach, ale każde otrzymuje osobny werdykt i osobne uzasadnienie.

## Grupa B — seam, adaptery, abstrakcje i reprezentacje

\`\`\`yaml
- id: SEAM-REAL-VARIATION
  name: Seam odpowiada realnej osi zmienności
  description: Interfejs, strategia, plugin albo seam rozdziela istniejące warianty, zewnętrzną granicę lub jawnie wymagane odmienne zachowania.
  applies_when: Zmiana dodaje lub modyfikuje seam, interfejs implementacyjny, strategię, plugin albo punkt podmiany.
  pass_when:
      - Allowed_sources pokazują co najmniej dwa semantycznie odmienne warianty, realną granicę procesu lub zatwierdzone wymaganie konkretnej podmiany.
  fail_when:
      - Istnieje jeden wariant, brak realnej granicy i brak jawnego wymagania zmiany, a seam służy wyłącznie mockowi albo hipotetycznej przyszłości.
  exceptions:
      - Port izoluje zewnętrzny proces, vendor SDK, transport lub storage nawet przy jednej bieżącej implementacji.
      - Platforma wymaga interfejsu jako punktu integracji.
  severity: major
  evidence_required:
      - Definicja seam i wszystkie znane implementacje w allowed_sources.
      - Kontrakt realnej granicy albo jawne wymaganie wariantu lub podmiany.
      - Callsite pokazujący, jak wariant jest wybierany.
  deterministic_check: 'owner: harness; policz implementacje, miejsca wyboru i użycia seam oraz oznacz implementacje test-only; liczba implementacji jest dowodem, nie automatycznym werdyktem'

- id: ADAPTER-BOUNDARY-ISOLATION
  name: Adapter izoluje zewnętrzny kontrakt
  description: Adapter zatrzymuje semantykę transportu, storage lub vendora na granicy i przedstawia callerom kontrakt należący do systemu.
  applies_when: Zmiana dodaje albo modyfikuje adapter do zewnętrznego API, transportu, storage, SDK lub schematu wire.
  pass_when:
      - Mapowanie typów, błędów, auth, retry lub semantyki protokołu jest skupione w adapterze, a domenowi callerzy nie zależą od zewnętrznych szczegółów.
  fail_when:
      - Zewnętrzny typ, kod, retry albo szczegół protokołu przecieka do co najmniej jednego domenowego callera poza adapterem bez zastosowania jawnego wyjątku.
  exceptions:
      - System świadomie wystawia surowy kontrakt jako gateway, co potwierdza publiczna specyfikacja.
      - Adapter jest cienki, lecz stanowi jedyny punkt zależności od generowanego klienta i chroni stabilny kontrakt systemu.
  severity: major
  evidence_required:
      - Kontrakt zewnętrzny i implementacja adaptera.
      - Typy oraz błędy widoczne po obu stronach granicy.
      - Co najmniej jeden domenowy caller.
  deterministic_check: 'owner: harness; znajdź importy zewnętrznego SDK, typy wire, kody protokołu i konfigurację retry poza adapterem; raportuj lokalizacje, nie oceniaj dopuszczalności'

- id: DATA-CANONICAL-REPRESENTATION
  name: Pojęcie ma jedną kanoniczną reprezentację wewnątrz właściciela
  description: W obrębie jednego kontekstu zachowanie opiera się na jednej reprezentacji pojęcia, a formy graniczne są tłumaczone na wejściu lub wyjściu.
  applies_when: Zmienione pojęcie występuje w co najmniej dwóch strukturach danych, DTO, modelach albo mapowaniach.
  pass_when:
      - Jedna reprezentacja jest jawnie używana do logiki wewnętrznej, a pozostałe formy istnieją tylko na nazwanych granicach.
  fail_when:
      - Równoległe równoważne reprezentacje konkurują wewnątrz tego samego właściciela i wymagają wielokrotnych mapowań bez różnicy kontraktowej.
  exceptions:
      - Oddzielne wire, persistence i domain forms chronią realnie różne kontrakty i są tłumaczone wyłącznie na ich granicach.
      - Okresowa migracja ma jawny termin usunięcia starej formy i test zgodności.
  severity: major
  evidence_required:
      - Definicje wszystkich reprezentacji pojęcia w ocenianym kontekście.
      - Mappery i miejsca wykonywania logiki na tych reprezentacjach.
      - Kontrakty granic uzasadniające różnice.
  deterministic_check: 'owner: harness; zbuduj graf typów i mapperów dla pojęcia oraz policz reprezentacje używane przez logikę wewnętrzną; graf jest dowodem, nie automatycznym FAIL'

- id: DATA-VALUE-OBJECT-INVARIANT
  name: Value object skupia invariant lub znaczenie typu
  description: Value object zapobiega niepoprawnemu stanowi, normalizuje wartość albo nadaje typowi obserwowalne znaczenie używane przez callerów.
  applies_when: Zmiana dodaje lub modyfikuje value object albo zastępuje nim prymityw.
  pass_when:
      - Konstrukcja lub operacje obiektu centralnie egzekwują invariant, normalizację, semantykę jednostki albo rozróżnienie identyfikatorów.
  fail_when:
      - Obiekt jedynie opakowuje wartość i przekazuje get/set, nie usuwając z callerów walidacji, interpretacji ani ryzyka pomylenia typów.
  exceptions:
      - Nominalny typ bez zachowania zapobiega obserwowalnemu pomyleniu jednostek lub identyfikatorów potwierdzonemu kontraktem typów.
      - Framework serializacyjny wymaga struktury granicznej, która nie jest przedstawiana jako value object domenowy.
  severity: minor
  evidence_required:
      - Konstruktor, fabryki i operacje value objectu.
      - Callsite'y przed i po zmianie albo równoważny baseline.
      - Testy lub kontrakt invariantu, normalizacji bądź rozróżnienia typów.
  deterministic_check: 'owner: harness; znajdź walidacje i interpretacje opakowanego prymitywu przed oraz po zmianie; raportuj ich lokalizacje i liczbę bez progu werdyktu'

- id: ABSTRACTION-CALLER-KNOWLEDGE
  name: Abstrakcja usuwa wiedzę z callera
  description: Helper lub abstrakcja zastępuje u callera nazwany koncept, decyzję albo sekwencję, a nie tylko przenosi identyczny kod.
  applies_when: Zmiana wyodrębnia helper, funkcję, klasę lub moduł używany przez callera.
  pass_when:
      - Caller operuje na intencji i nie musi znać kroków, kolejności ani decyzji ukrytych przez abstrakcję.
  fail_when:
      - Po ekstrakcji caller nadal wybiera te same kroki i parametry w tej samej kolejności, a kod został wyłącznie przeniesiony.
  exceptions:
      - Ekstrakcja usuwa duplikację jednej stabilnej reguły potwierdzonej w co najmniej dwóch callerach.
      - Nazwana funkcja izoluje niebezpieczną operację lub obowiązkowe sprawdzenie, którego pominięcie narusza kontrakt.
  severity: minor
  evidence_required:
      - Caller i pełna implementacja abstrakcji.
      - Baseline sprzed ekstrakcji albo równoważne użycie bez abstrakcji.
      - Kontrakt ukrywanej decyzji lub sekwencji.
  deterministic_check: 'owner: harness; porównaj parametry, branche i kolejność operacji przed oraz po ekstrakcji; podobieństwo tekstu jest dowodem pomocniczym, nie werdyktem'

- id: ABSTRACTION-SHARED-CONTRACT
  name: Wspólna abstrakcja łączy zachowania o wspólnym kontrakcie
  description: Połączone implementacje mają ten sam invariant i zmieniają się z tego samego powodu, nie tylko wyglądają podobnie.
  applies_when: Zmiana łączy co najmniej dwa dotąd niezależne miejsca za wspólną abstrakcją, generykiem lub bazową klasą.
  pass_when:
      - Allowed_sources wskazują wspólny kontrakt lub invariant, a reprezentatywna zmiana tego kontraktu powinna objąć wszystkie połączone miejsca.
  fail_when:
      - Miejsca należą do niezależnych kontekstów i mogą zmieniać się osobno, a jedynym dowodem wspólności jest podobny tekst lub aktualny kształt danych.
  exceptions:
      - Współdzielony kod jest bezstanową, dobrze zdefiniowaną operacją techniczną bez polityki domenowej.
  severity: major
  evidence_required:
      - Wszystkie połączone implementacje i ich callerzy.
      - Wspólny kontrakt lub invariant.
      - Co najmniej jedna wiarygodna zmiana pokazująca wspólny albo niezależny kierunek ewolucji.
  deterministic_check: 'owner: harness; zestaw historię lub przekazane sondy zmian połączonych miejsc i raportuj współzmienność tylko jako dowód; brak historii nie dowodzi wspólnego kontraktu'
\`\`\`

## Agregacja

Nie dodawaj osobnych pól \`depth\`, \`leverage\` ani \`locality\` do JSON. Użyj wyłącznie \`overall_verdict\` i reguł agregacji wspólnego kontraktu. Wynik jednej sondy nie przenosi się automatycznie na inną: na przykład lokalna zmiana progu nie dowodzi wymienności vendora. \`FAIL\` licznika bez semantycznego przypisania miejsc do tej samej wiedzy jest nieważny.

## Kotwice kalibracyjne

| Przypadek                                                                                                                                                                                                                                                                      | Oczekiwany wynik                                                                                                                                         | Granica decyzji                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cienki adapter jest jedynym miejscem importu vendor SDK, mapuje błędy i auth na stabilny kontrakt systemu.                                                                                                                                                                     | \`ADAPTER-BOUNDARY-ISOLATION: PASS\`; cienkość nie powoduje porażki innych kryteriów dzięki wyjątkowi granicy.                                             | Niezbędny adapter może wyglądać jak delegacja, jeśli rzeczywiście zatrzymuje kontrakt transportu.                                                                      |
| Kod dodaje strategię z jedną implementacją, bez zewnętrznej granicy i bez zatwierdzonego wariantu.                                                                                                                                                                             | \`SEAM-REAL-VARIATION: FAIL\`.                                                                                                                             | Potencjalna przyszłość i testowy mock nie ustanawiają realnej zmienności.                                                                                              |
| Zmiana nie dodaje seam, adaptera ani value objectu.                                                                                                                                                                                                                            | Odpowiednio \`SEAM-REAL-VARIATION\`, \`ADAPTER-BOUNDARY-ISOLATION\` i \`DATA-VALUE-OBJECT-INVARIANT: NOT_APPLICABLE\`.                                         | Nie oceniaj nieobecnej konstrukcji i nie używaj domyślnego pozytywnego werdyktu.                                                                                       |
| Zatwierdzone wymaganie uzasadnia konkretną podmianę A/B, lecz diff realizuje obecnie tylko A; komplet allowed_sources zawiera miejsce wyboru wariantu.                                                                                                                         | \`SEAM-REAL-VARIATION: PASS\`; brak implementacji B może być odrębnym niespełnieniem bieżącego wymagania, ale nie jest sprzecznym dowodem w tym kryterium. | Wymagany stan docelowy i obserwowany stan bieżący opisują różne rzeczy; to kryterium ocenia, czy seam ma realną oś zmienności, a nie kompletność realizacji wymagania. |
| Zatwierdzone wymaganie uzasadnia konkretną podmianę A/B, ale w allowed_sources brakuje wymaganego callsite'u pokazującego wybór wariantu.                                                                                                                                      | \`SEAM-REAL-VARIATION: INSUFFICIENT_CONTEXT\`; po dostarczeniu miejsca wyboru i pozostałych wymaganych dowodów \`PASS\`.                                     | Nazwij brakujące miejsce wyboru; nie zamieniaj brakującego dowodu w \`CONFLICTING_EVIDENCE\`.                                                                            |
| Dwa równie autorytatywne i obowiązujące źródła bez reguły pierwszeństwa podają przeciwne wymagania: jedno nakazuje podmianę A/B, drugie nakazuje jeden stały wariant i brak seam.                                                                                              | \`SEAM-REAL-VARIATION: CONFLICTING_EVIDENCE\`, z cytatami i lokalizacjami obu źródeł.                                                                      | Konflikt wymaga przeciwnych twierdzeń autorytatywnych, których rubryka nie potrafi rozstrzygnąć, a nie różnicy między wymaganiem i niepełnym diffem.                   |`,
} satisfies JudgeDefinition;
