import type { JudgeDefinition } from "../types";

export const stateLifecycleJudge = {
	id: "contract-state/state-lifecycle",
	judgeType: "contract-state",
	rubricVersion: "contract-state-judge-v2.0.0",
	criterionIds: ["STATE-01", "STATE-02", "STATE-03", "STATE-04", "STATE-05"],
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

## Grupa chronionego stanu i lifecycle

Ta grupa zawiera pięć kryteriów wysokiego ryzyka i stanowi osobne wywołanie judge’a.

\`\`\`yaml
criteria:
    - id: STATE-01
      name: Wykluczenie niedozwolonego stanu
      description: Wskazany wariant stanu zakazany przez jawny invariant nie jest osiągalny przez objętą publiczną ścieżkę.
      applies_when: Dozwolone źródło identyfikuje chroniony stan, jeden zakazany wariant oraz publiczną ścieżkę, która może go osiągnąć.
      pass_when:
          - Objęta publiczna ścieżka odrzuca wskazany wariant przed utrwaleniem albo reprezentacja uniemożliwia jego utworzenie.
          - Wymagany wynik kontroli deterministycznej potwierdza odrzucenie lub niereprezentowalność w ocenianym zakresie.
      fail_when:
          - Objęta publiczna ścieżka kończy się sukcesem lub utrwala wskazany wariant zakazany przez jawny invariant.
      exceptions:
          - Surowy DTO, rekord transportowy, builder przed walidacją, cache lub lokalny stan prezentacji bez zadeklarowanego invariantu.
          - Jawnie oznaczona reprezentacja pośrednia, która nie może wejść do operacji domenowych ani zostać utrwalona przed walidacją.
      severity: critical
      evidence_required:
          - Lokalizacja definicji zakazanego wariantu w jawnym kontrakcie.
          - Lokalizacja objętej publicznej ścieżki prowadzącej do tego wariantu.
          - Wynik adekwatnego type checkera, schema validatora albo testu negatywnego, property-based lub modelowego obejmującego wskazany wariant.
      deterministic_check: Właściciel harnessu uruchamia dostępny type checker, schema validator albo test negatywny/modelowy przypisany do STATE-01; kontrola wskazuje wariant i objętą ścieżkę.

    - id: STATE-02
      name: Nazwany postcondition publicznej konstrukcji
      description: Wskazana poprawna klasa wejścia publicznej konstrukcji daje model domenowy lub value object spełniający jeden nazwany postcondition.
      applies_when: Artefakt dodaje lub zmienia publiczny konstruktor, fabrykę, deserializację albo adapter, a dozwolone źródło definiuje wskazaną poprawną klasę wejścia, oczekiwany obiekt i jeden nazwany postcondition oceniany w tym wywołaniu.
      pass_when:
          - Dla wskazanej poprawnej klasy wejścia konstrukcja zwraca obiekt spełniający nazwany postcondition.
      fail_when:
          - Wskazana poprawna klasa wejścia jest odrzucana, więc konstrukcja nie zapewnia nazwanego postconditionu wbrew kontraktowi.
          - Konstrukcja zwraca obiekt niespełniający nazwanego postconditionu wskazanej poprawnej klasy wejścia.
      exceptions:
          - Surowy DTO lub builder, którego publiczny kontrakt jawnie dopuszcza stan niewalidowany i wymaga późniejszej, obserwowalnej granicy walidacji.
      severity: major
      evidence_required:
          - Publiczna sygnatura i implementacja objętej ścieżki konstrukcji.
          - Definicja wskazanej poprawnej klasy wejścia i jednego nazwanego postconditionu obiektu wynikowego.
          - Wynik testu wskazanej poprawnej klasy wejścia obserwującego nazwany postcondition.
      deterministic_check: Właściciel harnessu uruchamia przypisany test poprawnej konstrukcji; test asercyjnie sprawdza jeden nazwany postcondition.

    - id: STATE-03
      name: Zachowanie wskazanego invariantu przez mutację
      description: Wskazana publiczna mutacja zachowuje jeden nazwany invariant obowiązujący po operacji.
      applies_when: Artefakt dodaje lub zmienia publiczną operację mutującą chroniony stan, a dozwolone źródło określa jeden invariant obowiązujący po tej operacji.
      pass_when:
          - Dla objętych wartości granicznych operacja kończy się stanem spełniającym wskazany invariant albo jawnie odrzuca mutację bez pozostawienia stanu naruszającego ten invariant.
      fail_when:
          - Konkretny przebieg publicznej mutacji kończy się stanem naruszającym wskazany invariant.
          - Odrzucona mutacja pozostawia częściowo zmieniony stan naruszający wskazany invariant.
      exceptions:
          - Jawnie kontraktowa operacja rozpoczynająca stan przejściowy, jeśli wskazany invariant nie obowiązuje w tym stanie i operacja nie przedstawia go jako końcowego.
      severity: critical
      evidence_required:
          - Lokalizacja mutacji oraz definicja jednego invariantu obowiązującego po niej.
          - Obserwacja stanu przed i po operacji, w tym ścieżki odrzucenia.
          - Wynik testu behawioralnego, property-based lub modelowego obejmującego wartości graniczne i co najmniej jedną ścieżkę błędu.
      deterministic_check: Właściciel harnessu uruchamia przypisany test mutacji, property-based lub modelowy; wynik obserwuje wskazany invariant po sukcesie i po odrzuceniu.

    - id: STATE-04
      name: Dopuszczenie przejścia lifecycle
      description: Jedna wskazana para stanu źródłowego i operacji lifecycle jest akceptowana albo odrzucana zgodnie z jawną regułą przejścia.
      applies_when: Artefakt dodaje lub zmienia operację lifecycle, a dozwolone źródło określa dopuszczalność jednej pary stanu źródłowego i operacji.
      pass_when:
          - Jeśli autorytatywna reguła oznacza wskazaną parę jako dozwoloną, operacja ją przyjmuje; jeśli oznacza ją jako niedozwoloną, operacja ją odrzuca zadeklarowanym błędem.
      fail_when:
          - Wskazana dozwolona para jest odrzucana wbrew kontraktowi.
          - Wskazana niedozwolona para jest przyjmowana wbrew kontraktowi.
      exceptions: []
      severity: critical
      evidence_required:
          - Jawna tabela, typ lub kontrakt dopuszczalności wskazanej pary.
          - Implementacja publicznej operacji przejścia.
          - Wynik testu tabelarycznego lub modelowego dla wskazanej pary.
      deterministic_check: Właściciel harnessu uruchamia przypisany test tabelaryczny lub modelowy i porównuje decyzję o dopuszczeniu wskazanej pary z autorytatywną regułą.

    - id: STATE-05
      name: Stan docelowy przejścia lifecycle
      description: Jedno zaakceptowane przejście lifecycle kończy się stanem docelowym zadeklarowanym dla wskazanej pary stanu źródłowego i operacji.
      applies_when: Objęta operacja lifecycle akceptuje wskazany stan źródłowy, a dozwolone źródło definiuje stan docelowy tej pary.
      pass_when:
          - Po zaakceptowanym przejściu obserwowany stan jest równy zadeklarowanemu stanowi docelowemu.
      fail_when:
          - Po zaakceptowanym przejściu obserwowany stan różni się od zadeklarowanego stanu docelowego.
      exceptions: []
      severity: critical
      evidence_required:
          - Jawna definicja stanu docelowego dla wskazanej pary.
          - Implementacja publicznej operacji przejścia.
          - Wynik testu behawioralnego lub modelowego obserwującego stan po przejściu.
      deterministic_check: Właściciel harnessu uruchamia przypisany test lifecycle i porównuje obserwowany stan po przejściu z zadeklarowanym stanem docelowym.
\`\`\`

## Kotwice kalibracyjne

- **Niedozwolony stan — \`FAIL\`:** kontrakt zabrania \`balance < 0\`; publiczne \`withdraw\` dla salda \`5\` i kwoty \`6\` kończy się sukcesem, a test integracyjny obserwuje utrwalone \`-1\`. \`STATE-01\` i, jeśli operacja jest mutacją, \`STATE-03\` otrzymują osobne dowody z tych samych lokalizacji.
- **Surowy DTO — \`NOT_APPLICABLE\`:** payload transportowy przechowuje niezwalidowany tekst, lecz dozwolone źródła nie przypisują DTO invariantu, a osobna fabryka domenowa stanowi granicę walidacji. \`STATE-02\` nie dotyczy samego DTO; fabrykę ocenia się osobno, jeśli jest w zakresie.
- **Dozwolona para i stan docelowy — \`PASS\`:** tabela przejść dopuszcza \`pending + activate -> active\`; test lifecycle przyjmuje parę i obserwuje \`active\`. \`STATE-04\` przechodzi dla decyzji o dopuszczeniu, a \`STATE-05\` osobno dla stanu docelowego.
- **Niedozwolona para — \`FAIL\`:** tabela zabrania \`closed + activate\`, lecz test lifecycle obserwuje przyjęcie operacji. \`STATE-04\` otrzymuje \`FAIL\`; nie oceniaj \`STATE-05\`, jeśli kontrakt nie definiuje stanu docelowego dla odrzuconej pary.
- **Kontrakt kontra zachowanie — \`FAIL\`:** autorytatywna tabela dopuszcza \`pending + activate\`, lecz test lifecycle zwraca zadeklarowany błąd dla tej samej pary. \`STATE-04\` otrzymuje \`FAIL\`, ponieważ obserwowane zachowanie spełnia \`fail_when\`.
- **Sprzeczne kontrakty — \`CONFLICTING_EVIDENCE\`:** dwie obowiązujące według manifestu, równie autorytatywne tabele dla tej samej wersji przeciwnie klasyfikują \`pending + activate\`, a polityka nie określa pierwszeństwa. Dla \`STATE-04\` podaj oba źródła; jeśli brakuje tylko identyfikatora wersji, użyj \`INSUFFICIENT_CONTEXT\`.`,
} satisfies JudgeDefinition;
