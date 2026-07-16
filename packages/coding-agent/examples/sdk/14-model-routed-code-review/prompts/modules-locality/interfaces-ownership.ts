import type { JudgeDefinition } from "../types";

export const interfacesOwnershipJudge = {
	id: "modules-locality/interfaces-ownership",
	judgeType: "modules-locality",
	rubricVersion: "readable-code-modules-locality/2.0.0",
	criterionIds: [
		"MOD-INTERFACE-KNOWLEDGE",
		"MOD-DELETION-DEPTH",
		"MOD-LEVERAGE",
		"MOD-CHANGE-LOCALITY",
		"MOD-POLICY-OWNERSHIP",
		"MOD-SAME-OPERATION-LAYERING",
		"MOD-CALLER-BEHAVIOR",
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

## Grupa A — interfejs, depth i własność zachowania

\`\`\`yaml
- id: MOD-INTERFACE-KNOWLEDGE
  name: Interfejs ogranicza wiedzę callera
  description: Caller może zlecić zachowanie bez znajomości wewnętrznego retry, kolejności kroków, cache, defaultów ani stanu modułu.
  applies_when: Zmieniony artefakt udostępnia interfejs używany przez co najmniej jednego callera.
  pass_when:
      - Bezpośredni caller przekazuje dane należące do publicznego kontraktu i nie odtwarza mechaniki ukrytej w implementacji.
  fail_when:
      - Caller musi ustawiać albo koordynować wewnętrzne retry, kolejność, cache, defaulty lub stan wyłącznie po to, by moduł działał poprawnie.
  exceptions:
      - Parametr jest świadomą częścią publicznej polityki callera, a nie przeciekiem implementacji modułu.
      - Niskopoziomowa biblioteka celowo eksponuje mechanizm, co potwierdza jej przekazany kontrakt.
  severity: major
  evidence_required:
      - Definicja interfejsu i odpowiadająca implementacja.
      - Co najmniej jeden reprezentatywny bezpośredni caller.
      - Publiczny kontrakt rozstrzygający sporne parametry.
  deterministic_check: "owner: harness; zestaw parametry i callsite'y interfejsu z odwołaniami do retry, ordering, cache, defaultów i stanu; raport jest indeksem dowodów, nie werdyktem"

- id: MOD-DELETION-DEPTH
  name: Moduł zachowuje głębokość po deletion test
  description: Usunięcie granicy zmusza callerów do przejęcia ukrytego zachowania, polityki, invariantu lub translacji.
  applies_when: Zmiana dodaje, usuwa albo istotnie modyfikuje moduł lub wrapper.
  pass_when:
      - Symulacja usunięcia pokazuje, że callerzy musieliby przejąć konkretną logikę, politykę, invariant lub translację należącą do modułu.
  fail_when:
      - Po usunięciu callerzy mogą wywołać tę samą zależność bezpośrednio, bez przejęcia wiedzy i bez zmiany obserwowalnego kontraktu.
  exceptions:
      - Cienka granica jest wymagana przez framework, transakcję, autoryzację, obserwowalność lub izolację zewnętrznego kontraktu i dowód pokazuje tę odpowiedzialność.
      - Adapter transportowy spełnia kryterium ADAPTER-BOUNDARY-ISOLATION.
  severity: minor
  evidence_required:
      - Definicja modułu i wszystkich bezpośrednich callerów objętych zmianą.
      - Opisana symulacja usunięcia wskazująca wiedzę, która przeniosłaby się do callerów.
  deterministic_check: "owner: harness; zbuduj call graph przed i po hipotetycznym inline oraz policz dotknięte callsite'y i operacje; liczby są dowodem do deletion test, bez progu automatycznej porażki"

- id: MOD-LEVERAGE
  name: Operacja interfejsu daje leverage
  description: Jedna wskazana operacja interfejsu ukrywa przed callerem konkretne zachowanie, decyzję albo invariant.
  applies_when: Harness wskazuje jedną operację publicznego lub wewnątrzsystemowego interfejsu i jej reprezentatywnego callera.
  pass_when:
      - Wskazana operacja wyraża intencję i ukrywa co najmniej jeden udokumentowany krok, decyzję albo invariant istotny dla callera.
  fail_when:
      - Wskazana operacja nie ukrywa przed callerem żadnego nazwanego kroku, decyzji ani invariantu; delegacja jeden do jednego i przekazywanie opcji implementacji są bezpośrednimi sygnałami takiego braku leverage.
  exceptions:
      - Jawnie niskopoziomowy kontrakt jest produktem modułu, a jego celem nie jest ukrycie mechanizmu.
      - Cienki adapter izoluje odrębny zewnętrzny kontrakt zgodnie z ADAPTER-BOUNDARY-ISOLATION.
  severity: minor
  evidence_required:
      - Wskazana operacja, jej implementacja i reprezentatywne użycie.
      - Kontrakt określający poziom abstrakcji operacji.
  deterministic_check: 'owner: harness; zestaw wskazaną operację interfejsu z delegowanymi operacjami implementacji i opcjami przekazywanymi przez callera; liczby są dowodem, nie werdyktem'

- id: MOD-CHANGE-LOCALITY
  name: Deklarowana zmiana zatrzymuje się u właściciela
  description: Jedna jawnie określona zmiana zachowania nie wymaga edycji niezależnych callerów ani równoległych reprezentacji.
  applies_when: Uzasadnienie zmiany deklaruje poprawę lokalności albo allowed_sources zawierają konkretny wymóg lub sondę zmiany dotyczącą modułu.
  pass_when:
      - Dla wskazanej zmiany edycje zachowania pozostają u jednego właściciela, a callerzy i reprezentacje poza jego granicą zachowują kontrakt.
  fail_when:
      - Ta sama decyzja semantyczna musi zostać zmieniona u wielu niezależnych callerów lub w wielu wewnętrznych reprezentacjach.
  exceptions:
      - Jawna zmiana publicznego kontraktu z natury wymaga migracji jego konsumentów; oceniaj tylko niepotrzebne dodatkowe rozproszenie.
      - Edycje wygenerowanych artefaktów pochodzą z jednego kanonicznego źródła.
  severity: major
  evidence_required:
      - Treść konkretnego wymagania albo sondy zmiany.
      - Właściciel zachowania, jego bezpośredni callerzy i reprezentacje objęte sondą.
      - Wynik symulacji zmiany lub równoważny diff.
  deterministic_check: "owner: harness; zastosuj lub zasymuluj przekazaną sondę i raportuj liczbę oraz lokalizacje dotkniętych właścicieli, callsite'ów, reprezentacji i testów względem baseline; wynik jest dowodem, nie automatycznym FAIL"

- id: MOD-POLICY-OWNERSHIP
  name: Polityka należy do właściciela danych i invariantów
  description: Reguła decyzyjna jest wykonywana przez komponent odpowiedzialny za dane i invarianty, których reguła dotyczy.
  applies_when: Zmieniony kod podejmuje decyzję na podstawie stanu należącego do modułu albo obiektu domenowego.
  pass_when:
      - Właściciel stanu udostępnia operację zachowania lub decyzję, a caller nie składa tej reguły z cudzych pól.
  fail_when:
      - Caller pobiera stan właściciela i sam implementuje należącą do niego regułę, zwłaszcza gdy wzorzec występuje w więcej niż jednym callerze.
  exceptions:
      - Reguła jest polityką orkiestracji należącą do callera i łączy kilka równorzędnych właścicieli.
      - Odczyt służy wyłącznie prezentacji bez podejmowania decyzji domenowej.
  severity: major
  evidence_required:
      - Definicja danych lub stanu i miejsca egzekwowania ich invariantów.
      - Kod decyzji oraz bezpośredni caller.
      - Kontrakt domenowy wskazujący właściciela, jeśli własność jest sporna.
  deterministic_check: "owner: harness; znajdź callsite'y, które odczytują te same pola i wykonują porównania lub branch; raportuj lokalizacje bez przypisywania własności"

- id: MOD-SAME-OPERATION-LAYERING
  name: Sąsiednie warstwy zmieniają poziom operacji
  description: Każda sąsiednia warstwa wnosi odrębną operację semantyczną albo egzekwuje realną granicę, zamiast powtarzać tę samą operację.
  applies_when: Zmieniona ścieżka wywołania przechodzi przez co najmniej dwie lokalne warstwy lub wrappery.
  pass_when:
      - Kolejne wywołania przechodzą od intencji do polityki, translacji, efektu lub egzekwowania jawnej granicy.
  fail_when:
      - Łańcuch powtarza tę samą operację i argumenty, a warstwy jedynie przekazują lub zmieniają nazwę wywołania.
  exceptions:
      - Warstwa egzekwuje transakcję, autoryzację, idempotency, obserwowalność lub granicę procesu potwierdzoną kodem albo kontraktem.
      - Wymagana integracja frameworka narzuca punkt wejścia, którego nie kontroluje projekt.
  severity: minor
  evidence_required:
      - Pełna ścieżka wywołania między zmienionym wejściem i efektem.
      - Implementacja odpowiedzialności każdej warstwy.
  deterministic_check: 'owner: harness; wypisz liniowy łańcuch wywołań, mapowanie argumentów i efekty uboczne każdej warstwy; podobieństwo nazw jest wskazówką, nie werdyktem'

- id: MOD-CALLER-BEHAVIOR
  name: Caller wywołuje zachowanie zamiast rekonstruować je z danych
  description: Caller używa operacji wyrażającej intencję, zamiast składać zachowanie z sekwencji getterów i setterów właściciela.
  applies_when: Caller odczytuje lub zapisuje co najmniej dwa elementy stanu tego samego właściciela w celu wykonania jednej operacji.
  pass_when:
      - Sekwencja jest czystą prezentacją albo caller deleguje decyzję do operacji właściciela.
  fail_when:
      - Caller odczytuje pola właściciela, wylicza jego decyzję i zapisuje wynik, przez co zna kolejność lub invariant operacji.
  exceptions:
      - Kod jest mapperem na rzeczywistej granicy reprezentacji i nie podejmuje decyzji domenowej.
      - Narzędzie migracyjne jednorazowo przekształca stan poza ścieżką produkcyjną.
  severity: major
  evidence_required:
      - Cała operacja callera i API właściciela stanu.
      - Invarianty lub testy określające obserwowalne zachowanie.
  deterministic_check: 'owner: harness; znajdź sekwencje wielu getterów/setterów tego samego receivera w jednej operacji i zwróć lokalizacje; sekwencja nie jest sama w sobie naruszeniem'
\`\`\`

## Agregacja

Nie dodawaj osobnych pól \`depth\`, \`leverage\` ani \`locality\` do JSON. Użyj wyłącznie \`overall_verdict\` i reguł agregacji wspólnego kontraktu. Wynik jednej sondy nie przenosi się automatycznie na inną: na przykład lokalna zmiana progu nie dowodzi wymienności vendora. \`FAIL\` licznika bez semantycznego przypisania miejsc do tej samej wiedzy jest nieważny.

## Kotwice kalibracyjne

| Przypadek                                                                                                                                                                                                                                                                      | Oczekiwany wynik                                                                                                                                         | Granica decyzji                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrapper przekazuje \`create(x)\` do \`create(x)\` i nie egzekwuje granicy ani polityki.                                                                                                                                                                                            | \`MOD-DELETION-DEPTH: FAIL\`; \`MOD-SAME-OPERATION-LAYERING: FAIL\`.                                                                                         | Sama nazwa modułu i łatwiejszy mock nie są zachowaniem ukrytym przed callerem.                                                                                         |
| Uzasadnienie deklaruje poprawę lokalności modułu, więc \`MOD-CHANGE-LOCALITY\` ma zastosowanie, lecz allowed_sources nie zawierają konkretnej zmiany ani wyniku jej symulacji.                                                                                                   | \`MOD-CHANGE-LOCALITY: INSUFFICIENT_CONTEXT\`.                                                                                                             | Nazwij brakującą treść zmiany i symulację; brak dowodu dla kryterium mającego zastosowanie nie jest dowodem shotgun change.                                            |
| Raport referencji pokazuje wiele plików i callsite'ów w niezależnych kontekstach, lecz przypisanie semantyczne oraz symulacja wskazanej zmiany pokazują edycję zachowania u jednego właściciela; pozostałe trafienia realizują odmienne polityki i nie współdzielą tej wiedzy. | \`MOD-CHANGE-LOCALITY: PASS\`.                                                                                                                             | Wysoki licznik miejsc jest indeksem do inspekcji, nie kosztem semantycznym; bez wspólnej decyzji lub wiedzy nie uzasadnia \`FAIL\`.                                      |
| Ta sama decyzja semantyczna jest ręcznie zakodowana tylko w dwóch niezależnych callerach i sonda wymaga zmiany obu.                                                                                                                                                            | \`MOD-CHANGE-LOCALITY: FAIL\`.                                                                                                                             | Mały licznik nie chroni przed porażką, gdy miejsca rzeczywiście współdzielą wiedzę objętą jedną zmianą.                                                                |`,
} satisfies JudgeDefinition;
