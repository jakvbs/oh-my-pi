import type { JudgeDefinition } from "../types";

export const policyOwnershipJudge = {
	id: "contract-state/policy-ownership",
	judgeType: "contract-state",
	rubricVersion: "contract-state-judge-v2.0.0",
	criterionIds: ["OWNER-01", "OWNER-02", "OWNER-03", "OWNER-04"],
	prompt: `# Judge kontraktu, invariantów i stanu

Rubryka ocenia, czy zmiana utrzymuje zadeklarowany kontrakt chronionego stanu, przejść lifecycle, błędów domenowych i polityk granicznych. Nie ocenia preferowanego stylu modelowania ani nie wymaga nowej warstwy architektonicznej.


\`\`\`yaml
rubric_version: contract-state-judge-v2.0.0
\`\`\`

## Aktywacja i zakres

Użyj tej rubryki, gdy artefakt tworzy lub mutuje stan chroniony regułami poprawności, definiuje model lub value object, zmienia lifecycle, publiczne błędy domenowe, defaulty, mapowania, walidację, retry, timeout, ordering, cache, fallback albo compatibility branch. Dla każdej grupy oceniaj tylko kryteria, których \`applies_when\` potwierdza dozwolone źródło.

Nie zakładaj, że surowy DTO, rekord transportowy, builder przed walidacją, cache lub lokalny stan prezentacji jest modelem domenowym. Nie żądaj centralizacji tylko dlatego, że podobne fragmenty kodu istnieją: naruszeniem jest dopiero konkurująca definicja tej samej reguły. Nie rekomenduj refaktoru szerszego niż najmniejsza zmiana przywracająca potwierdzony kontrakt. Nie usuwaj fallbacku ani ścieżki kompatybilności bez dowodu, że jej kontrakt nie istnieje lub już nie obowiązuje.

## Dozwolone źródła domenowe

Spośród \`allowed_sources\` używaj wyłącznie źródeł przekazanych dla danego uruchomienia:

- artefaktu ze stabilnymi lokalizacjami oraz publicznych deklaracji typów i sygnatur objętych zakresem zmiany;
- jawnego kontraktu: specyfikacji, schematu, dokumentacji API, definicji modelu, tabeli przejść, konfiguracji albo polityki oznaczonej jako autorytatywna;
- bezpośrednich callerów i adapterów granicznych objętych zakresem, gdy pokazują sposób konstrukcji, mutacji, przejścia lub obsługi wyniku;
- testów behawioralnych, property-based, modelowych, integracyjnych i contract tests wraz z ich rzeczywistym wynikiem;
- przekazanych wyników kompilatora, type checkera, schema validatora, migracji lub innej kontroli wymienionej w \`deterministic_evidence\`;
- danych o wspieranych wersjach, rolloutcie lub realnym zachowaniu granicy, jeśli są potrzebne do oceny fallbacku albo kompatybilności.

Komentarz, nazwa symbolu lub test bez wyniku może wskazać miejsce inspekcji, ale nie potwierdza zachowania. Brak publicznego kontraktu nie upoważnia do wymyślenia go z konwencji projektu.

## Routing kontroli deterministycznych

Harness przypisuje wyniki kontroli do ID kryterium i przekazuje komendę lub validator, zakres, rezultat oraz lokalizację. Jeśli pole \`deterministic_check\` wskazuje kontrolę, a jej wynik jest niezbędny do rozstrzygnięcia, brak tego wyniku daje \`INSUFFICIENT_CONTEXT\`. Judge nie zastępuje tej kontroli interpretacją kodu.

- Wynik kompilatora lub type checkera rozstrzyga tylko własność gwarantowaną przez sprawdzany typ i wszystkie objęte publiczne ścieżki; nie dowodzi semantyki niewyrażonej w typie.
- Schema validator rozstrzyga akceptację lub odrzucenie wskazanych payloadów dla wskazanej wersji schematu.
- Test behawioralny rozstrzyga zaobserwowany przypadek. Uniwersalne zachowanie potwierdza wyłącznie kontrola wyczerpująca, property-based albo modelowa z przekazanym zakresem.
- Contract test lub test integracyjny może rozstrzygnąć publiczny błąd, efekt uboczny, fallback lub przejście tylko wtedy, gdy obserwuje rzeczywistą granicę istotną dla kryterium.
- Konflikt wyniku deterministycznego z wiarygodnym kontraktem lub obserwacją raportuj zgodnie ze wspólnym statusem \`CONFLICTING_EVIDENCE\`; nie wybieraj wygodniejszego źródła bez jawnej reguły pierwszeństwa.

## Grupa B — autorytatywny właściciel reguły

Ta grupa zawiera cztery semantycznie spójne kryteria i stanowi osobne wywołanie judge’a. „Jedno źródło” oznacza jedną autorytatywną definicję znaczenia; walidacja lub egzekwowanie na kilku granicach jest dozwolone, jeśli pozostaje pochodne wobec tej definicji.

\`\`\`yaml
criteria:
    - id: OWNER-01
      name: Właściciel definicji invariantu
      description: Ten sam invariant domenowy ma jedną autorytatywną definicję znaczenia w ocenianym zakresie.
      applies_when: Co najmniej dwa objęte miejsca definiują lub egzekwują semantycznie ten sam invariant.
      pass_when:
          - Dozwolone źródło wskazuje autorytatywną definicję, a pozostałe miejsca odwołują się do niej, są z niej generowane albo egzekwują równoważny wynik bez własnej konkurującej definicji.
      fail_when:
          - Co najmniej dwa objęte miejsca niezależnie utrzymują definicję semantycznie tego samego invariantu, nawet gdy ich bieżące warunki są równe; różne bieżące wyniki są dodatkowym bezpośrednim dowodem konkurencji.
      exceptions:
          - Niezależne reguły o podobnym zapisie, ale innym zakresie domenowym.
          - Pochodna walidacja na granicy, której zgodność z autorytatywną definicją potwierdza kontrola.
      severity: major
      evidence_required:
          - Lokalizacje wszystkich objętych definicji i miejsc egzekwowania.
          - Dozwolone źródło wskazujące właściciela albo bezpośredni dowód konkurujących wyników.
          - Wynik testu zgodności, jeśli równoważność definicji nie wynika mechanicznie z jednego źródła.
      deterministic_check: null

    - id: OWNER-02
      name: Właściciel defaultu
      description: Jeden default ma jednego jawnego właściciela odpowiedniego dla zakresu faktu albo polityki użycia.
      applies_when: Artefakt dodaje, zmienia lub powiela wartość stosowaną przy braku danych wejściowych.
      pass_when:
          - Wszystkie objęte ścieżki pobierają default z jawnie wskazanego źródła właściwego dla tego samego zakresu użycia.
      fail_when:
          - Bezpośredni caller i źródło danych lub dwa callery definiują różne defaulty dla tego samego braku danych i tego samego zakresu użycia.
          - Źródło faktu narzuca default zależny od use case’u mimo jawnego kontraktu przypisującego tę decyzję polityce użycia.
      exceptions:
          - Różne defaulty dla jawnie różnych use case’ów lub wersji kontraktu.
      severity: major
      evidence_required:
          - Lokalizacje wartości defaultu i wszystkich objętych miejsc jej zastosowania.
          - Jawny zakres użycia oraz wskazanie właściciela w kontrakcie, konfiguracji lub API.
          - Wynik testu dla braku wartości na każdej objętej publicznej ścieżce.
      deterministic_check: Właściciel harnessu uruchamia test tabelaryczny lub contract test braku wartości przypisany do OWNER-02; kontrola porównuje obserwowany default z autorytatywnym źródłem.

    - id: OWNER-03
      name: Właściciel mapowania
      description: Jedno mapowanie między tymi samymi domenami wejścia i wyjścia ma jedną autorytatywną definicję.
      applies_when: Artefakt dodaje, zmienia lub powiela mapowanie, a co najmniej dwa objęte miejsca dotyczą tych samych domen i wersji.
      pass_when:
          - Pozostałe objęte reprezentacje mapowania są generowane z autorytatywnego źródła albo test zgodności potwierdza identyczny wynik dla pełnego zadeklarowanego zbioru.
      fail_when:
          - Dwa aktywne objęte mapowania zwracają różne wyniki dla tego samego wejścia, zakresu i wersji bez kontraktowego rozróżnienia.
      exceptions:
          - Mapowania dla różnych wersji, granic lub celów, których odmienność jest jawna w kontrakcie.
      severity: major
      evidence_required:
          - Lokalizacje objętych mapowań oraz definicja ich domen i wersji.
          - Wskazanie autorytatywnego źródła.
          - Wynik generatora, schema check albo kompletnego testu tabelarycznego, jeśli projekt nim rozstrzyga zgodność.
      deterministic_check: Właściciel harnessu uruchamia przypisany generator, schema check lub test tabelaryczny dla pełnego zadeklarowanego zbioru mapowania.

    - id: OWNER-04
      name: Właściciel polityki granicznej
      description: Jedna polityka retry, timeoutu, orderingu lub cache dla tej samej operacji i zakresu ma jednego jawnego właściciela.
      applies_when: Artefakt dodaje lub zmienia retry, timeout, ordering albo cache, a ta sama operacja ma objęte zachowanie polityki w więcej niż jednym miejscu.
      pass_when:
          - Dozwolone źródło wskazuje właściciela, a warstwy pochodne nie dokładają sprzecznej lub nieudokumentowanej polityki dla tego samego zakresu.
      fail_when:
          - Dwie objęte warstwy nakładają sprzeczne limity, kolejność, okres cache albo warunki retry na tę samą operację i zakres.
          - Caller odtwarza tę samą politykę lokalnie i może odejść od autorytatywnego ustawienia.
      exceptions:
          - Jawnie złożone polityki różnych warstw, jeśli kontrakt określa ich kolejność i wynik łączny.
      severity: major
      evidence_required:
          - Lokalizacje konfiguracji i implementacji polityki na wszystkich objętych warstwach.
          - Jawny zakres operacji i właściciel polityki.
          - Obserwowany wynik testu granicznego czasu, kolejności, retry albo cache, jeśli konfiguracje są składane w runtime.
      deterministic_check: null
\`\`\`

## Kotwice kalibracyjne`,
} satisfies JudgeDefinition;
