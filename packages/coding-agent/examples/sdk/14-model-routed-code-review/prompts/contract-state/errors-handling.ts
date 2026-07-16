import type { JudgeDefinition } from "../types";

export const errorsHandlingJudge = {
	id: "contract-state/errors-handling",
	judgeType: "contract-state",
	rubricVersion: "contract-state-judge-v2.0.0",
	criterionIds: ["ERROR-01", "ERROR-02", "ERROR-03"],
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

## Grupa publicznych błędów i obsługi

Ta grupa zawiera trzy kryteria wysokiego ryzyka i stanowi osobne wywołanie judge’a.

\`\`\`yaml
criteria:
    - id: ERROR-01
      name: Publiczny błąd domenowy
      description: Jedna kontraktowa przyczyna niepowodzenia jest publicznie rozróżnialna przez callerów zobowiązanych do jej obsługi.
      applies_when: Artefakt dodaje lub zmienia publiczną operację z jawną domenową przyczyną niepowodzenia, która wymaga od callera odmiennej reakcji.
      pass_when:
          - Publiczny wynik, typ błędu, kod lub udokumentowany wyjątek pozwala objętym callerom jednoznacznie rozpoznać wskazaną przyczynę.
          - Test kontraktowy potwierdza reprezentację tej przyczyny na publicznej granicy.
      fail_when:
          - Wskazana kontraktowa przyczyna jest zwracana jako nierozróżnialne false, null, ogólny wyjątek lub pozorny sukces, przez co wymagany caller nie może zastosować zadeklarowanej reakcji.
      exceptions:
          - Przyczyny, które jawny publiczny kontrakt celowo agreguje i dla których caller nie ma odmiennej reakcji.
      severity: major
      evidence_required:
          - Jawny kontrakt przyczyny niepowodzenia i wymaganej reakcji callera.
          - Publiczna sygnatura oraz reprezentacja błędu na granicy.
          - Wynik contract testu lub testu integracyjnego wywołującego tę przyczynę.
      deterministic_check: Właściciel harnessu uruchamia przypisany contract test błędu; test sprawdza rozróżnialność wskazanej przyczyny przez publicznego callera.

    - id: ERROR-02
      name: Publiczny wynik obsługi błędu
      description: Pojedyncza objęta ścieżka catch, konwersji, fallbacku lub early return zwraca publiczny wynik zadeklarowany dla wskazanego błędu.
      applies_when: Artefakt dodaje lub zmienia obsługę wskazanego błędu, a jawny kontrakt definiuje publiczny wynik tej obsługi.
      pass_when:
          - Wywołanie wskazanego błędu daje dokładnie zadeklarowany publiczny wynik i nie przedstawia porażki jako sukcesu wbrew kontraktowi.
      fail_when:
          - Wskazany błąd jest połykany lub zamieniany na publiczny wynik sprzeczny z jawnym kontraktem.
      exceptions:
          - Jawnie kontraktowe best-effort lub idempotentna nieobecność, jeśli publiczny wynik odpowiada temu kontraktowi.
      severity: critical
      evidence_required:
          - Jawny kontrakt publicznego wyniku dla wskazanego błędu.
          - Lokalizacja przechwycenia lub konwersji oraz objętej publicznej granicy.
          - Wynik testu behawioralnego lub integracyjnego, który wywołuje błąd i obserwuje publiczny wynik.
      deterministic_check: Właściciel harnessu uruchamia przypisany test z kontrolowanym błędem granicy; test asercyjnie sprawdza publiczny wynik.

    - id: ERROR-03
      name: Jeden efekt obsługi błędu
      description: Pojedyncza objęta ścieżka obsługi wskazanego błędu realizuje jeden nazwany efekt zgodnie z kontraktowym oznaczeniem go jako wymaganego albo zakazanego w tym wywołaniu.
      applies_when: Artefakt dodaje lub zmienia obsługę wskazanego błędu, a jawny kontrakt definiuje jeden nazwany efekt tej obsługi jako wymagany albo zakazany.
      pass_when:
          - Jeśli nazwany efekt jest w tym wywołaniu wymagany, jest obserwowany po wywołaniu błędu; jeśli jest zakazany, nie jest obserwowany.
      fail_when:
          - Efekt wskazany jako wymagany nie występuje po wywołaniu błędu.
          - Efekt wskazany jako zakazany występuje po wywołaniu błędu.
      exceptions:
          - Jawnie kontraktowy cleanup lub best-effort, jeśli nazwany efekt spełnia własny jawny kontrakt.
      severity: critical
      evidence_required:
          - Jawny kontrakt jednego nazwanego efektu, w tym jego oznaczenie jako wymaganego albo zakazanego dla wskazanego błędu.
          - Lokalizacja obsługi błędu i implementacji nazwanego efektu.
          - Wynik testu behawioralnego lub integracyjnego obserwującego nazwany efekt po wywołaniu błędu.
      deterministic_check: Właściciel harnessu uruchamia przypisany test z kontrolowanym błędem granicy; test asercyjnie sprawdza jeden nazwany efekt zgodnie z jego oznaczeniem jako wymaganego albo zakazanego.
\`\`\`

## Kotwice kalibracyjne

- **Intencjonalne best-effort — \`PASS\`:** kontrakt telemetrii mówi, że błąd wysyłki nie zmienia wyniku operacji głównej i nie może przerwać cleanupu; test wywołuje błąd, obserwuje sukces operacji oraz wykonany cleanup. \`ERROR-02\` przechodzi dla wyniku, a \`ERROR-03\` osobno dla efektu.`,
} satisfies JudgeDefinition;
