import type { JudgeDefinition } from "../types";

export const changeProbesJudge = {
	id: "modules-locality/change-probes",
	judgeType: "modules-locality",
	rubricVersion: "readable-code-modules-locality/2.0.0",
	criterionIds: ["PROBE-POLICY-CHANGE", "PROBE-STATE-VARIANT", "PROBE-VENDOR-CHANGE", "PROBE-DOMAIN-SCENARIO"],
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

## Grupa C — sondy zmian

Uruchamiaj każde kryterium osobno dla jednej nazwanej sondy. Nie zastępuj brakującego wymagania własnym scenariuszem „na przyszłość”.

\`\`\`yaml
- id: PROBE-POLICY-CHANGE
  name: Sonda zmiany progu lub reguły
  description: Zmiana jednej wskazanej reguły albo progu wymaga modyfikacji jednego semantycznego właściciela.
  applies_when: Allowed_sources zawierają konkretną nową wartość progu lub zmianę reguły dotyczącą ocenianego kodu.
  pass_when:
      - Symulacja zmienia decyzję u jednego właściciela, a pozostałe edycje są danymi wejściowymi, testami kontraktu lub wygenerowanymi artefaktami z jednego źródła.
  fail_when:
      - Ta sama decyzja lub stała musi być ręcznie zmieniona u wielu niezależnych właścicieli.
  exceptions:
      - Jawnie rozdzielone konteksty mają podobne wartości, lecz odmienne polityki i nie powinny współdzielić właściciela.
  severity: major
  evidence_required:
      - Dokładna treść sondy progu lub reguły.
      - Diff symulacji z przypisaniem każdej edycji do właściciela semantycznego.
  deterministic_check: 'owner: harness; zasymuluj zmianę i policz pliki, wystąpienia, właścicieli, reprezentacje i testy; pokaż lokalizacje, lecz nie stosuj progu automatycznej porażki'

- id: PROBE-STATE-VARIANT
  name: Sonda dodania stanu lub wariantu
  description: Dodanie jednego wskazanego stanu lub wariantu nie wymaga powtórzenia tej samej dyskryminacji w niezależnych callerach.
  applies_when: Allowed_sources definiują konkretny nowy stan lub wariant oraz jego wymagane zachowanie.
  pass_when:
      - Rozpoznanie wariantu jest skupione u właściciela, a callerzy branchują tylko tam, gdzie mają własne odmienne zachowanie dla tego stanu.
  fail_when:
      - Ten sam warunek lub switch musi zostać dodany w wielu callerach, które powtarzają tę samą decyzję właściciela.
  exceptions:
      - Pojedynczy stabilny lokalny \`if\` wyraża zachowanie należące wyłącznie do tego callera i nie koduje wspólnej polityki.
      - Exhaustive matching jest wymagany przez typ i każdy branch realizuje odrębną odpowiedzialność callera.
  severity: major
  evidence_required:
      - Definicja nowego stanu lub wariantu i jego zachowania.
      - Wszystkie miejsca dyskryminacji objęte symulacją.
      - Własność zachowania wykonywanego w każdym branchu.
  deterministic_check: 'owner: harness; dodaj lub zasymuluj wariant i policz branche oraz switche według semantycznej decyzji i właściciela; sama liczba branchy nie powoduje FAIL'

- id: PROBE-VENDOR-CHANGE
  name: Sonda wymaganej zmiany vendora
  description: Gdy wymienność jest jawnym wymaganiem, konkretna zmiana vendora kończy się na adapterze i właścicielu polityki.
  applies_when: Wymaganie w allowed_sources nakazuje wymienność albo zmiana deklaruje neutralny seam dla konkretnego zewnętrznego kontraktu.
  pass_when:
      - Symulacja wskazanej różnicy API, błędów lub semantyki vendora zmienia adapter i ewentualnie politykę właściciela, bez zmian domenowych callerów.
  fail_when:
      - Ta sama różnica vendora wymaga zmian typów, kodów, retry lub branchy w wielu domenowych modułach.
  exceptions:
      - Zmiana narusza jawnie publiczny kontrakt produktu, więc migracja konsumentów jest częścią wymogu.
  severity: major
  evidence_required:
      - Jawne wymaganie wymienności albo deklarowany kontrakt neutralnego seam.
      - Konkretny stary i nowy kontrakt vendora lub precyzyjnie opisana różnica do zasymulowania.
      - Diff symulacji obejmujący adapter i domenowych callerów.
  deterministic_check: "owner: harness; zasymuluj konkretną różnicę vendora i policz importy SDK, typy, kody, branche, właścicieli i callsite'y dotknięte zmianą; licznik jest dowodem, nie automatycznym FAIL"

- id: PROBE-DOMAIN-SCENARIO
  name: Sonda nowego scenariusza domenowego
  description: Nowy wskazany scenariusz trafia do istniejącego właściciela właściwego zachowania, zamiast tworzyć zewnętrzną kopię jego polityki.
  applies_when: Allowed_sources opisują konkretny nowy scenariusz domenowy i oczekiwane zachowanie.
  pass_when:
      - Zmiana zachowania znajduje się u istniejącego właściciela albo tworzy nowego właściciela z jednoznacznym invariantem, a caller jedynie go uruchamia.
  fail_when:
      - Scenariusz jest realizowany przez kolejny zewnętrzny helper, manager lub branch, który odczytuje stan istniejącego właściciela i powtarza jego politykę.
  exceptions:
      - Scenariusz jest orkiestracją kilku właścicieli i nie należy w całości do żadnego z nich.
      - Jednorazowy handler graniczny tylko tłumaczy wejście i deleguje zachowanie.
  severity: major
  evidence_required:
      - Treść scenariusza i oczekiwany wynik.
      - Kod właściciela, callerów oraz nowej ścieżki zachowania.
      - Diff lub plan symulacji z przypisaniem decyzji do właścicieli.
  deterministic_check: 'owner: harness; zasymuluj scenariusz i raportuj lokalizacje nowych decyzji, helperów, mapperów, reprezentacji oraz testów; count służy znalezieniu rozproszenia, nie rozstrzyga go'
\`\`\`

## Agregacja

Nie dodawaj osobnych pól \`depth\`, \`leverage\` ani \`locality\` do JSON. Użyj wyłącznie \`overall_verdict\` i reguł agregacji wspólnego kontraktu. Wynik jednej sondy nie przenosi się automatycznie na inną: na przykład lokalna zmiana progu nie dowodzi wymienności vendora. \`FAIL\` licznika bez semantycznego przypisania miejsc do tej samej wiedzy jest nieważny.

## Kotwice kalibracyjne

| Przypadek                                                                                                                                                                                                                                                                      | Oczekiwany wynik                                                                                                                                         | Granica decyzji                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jeden lokalny \`if\` obsługuje stabilne zachowanie właściwe wyłącznie jednemu callerowi.                                                                                                                                                                                         | \`PROBE-STATE-VARIANT: PASS\`, gdy sonda potwierdza brak powtórzonej decyzji; bez sondy \`NOT_APPLICABLE\`.                                                  | Nie wprowadzaj strategii ani polimorfizmu tylko po to, by usunąć warunek.                                                                                              |`,
} satisfies JudgeDefinition;
