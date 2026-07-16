import type { JudgeDefinition } from "../types";

export const compatibilityFallbacksJudge = {
	id: "contract-state/compatibility-fallbacks",
	judgeType: "contract-state",
	rubricVersion: "contract-state-judge-v2.0.0",
	criterionIds: ["COMPAT-01", "COMPAT-02", "FALLBACK-01", "FALLBACK-02", "FALLBACK-03"],
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

## Grupa kompatybilności i fallbacków

Ta grupa zawiera pięć semantycznie spójnych kryteriów i stanowi osobne wywołanie judge’a.

\`\`\`yaml
criteria:
    - id: COMPAT-01
      name: Obowiązywanie wariantu kompatybilności
      description: Jeden wariant obsługiwany przez compatibility branch należy do wspieranej wersji, aktywnego rolloutu albo realnego wariantu protokołu.
      applies_when: Artefakt dodaje, zmienia lub utrzymuje branch opisany jako obsługa starszej wersji, częściowego rolloutu albo wariantu protokołu.
      pass_when:
          - Dozwolone dane o wersjach, rolloutcie lub protokole potwierdzają, że wskazany wariant jest objęty kontraktem w ocenianym zakresie czasu i wdrożenia.
      fail_when:
          - Dozwolone źródła wykluczają wspieranie wskazanego wariantu w ocenianym zakresie, a branch nie ma innego jawnego kontraktu.
      exceptions:
          - Czasowa ścieżka migracyjna z jawnym zakresem i potwierdzonym aktywnym rolloutem.
      severity: major
      evidence_required:
          - Macierz wspieranych wersji, dane rolloutu albo specyfikacja wariantu z datą lub zakresem obowiązywania.
          - Lokalizacja warunku branchu identyfikującego wskazany wariant.
      deterministic_check: null

    - id: COMPAT-02
      name: Wynik wariantu kompatybilności
      description: Dla jednego potwierdzonego wariantu compatibility branch zwraca publiczny wynik wymagany przez jego kontrakt.
      applies_when: Dozwolone źródło potwierdza obowiązywanie wskazanego wariantu kompatybilności i definiuje jego publiczny wynik.
      pass_when:
          - Contract test wskazanego wariantu obserwuje dokładnie zadeklarowany publiczny wynik.
      fail_when:
          - Dla wskazanego wariantu branch zwraca publiczny wynik sprzeczny z kontraktem kompatybilności.
      exceptions: []
      severity: major
      evidence_required:
          - Kontrakt publicznego wyniku dla wskazanego wariantu.
          - Lokalizacja zachowania branchu.
          - Wynik contract testu dla wskazanego wariantu.
      deterministic_check: Właściciel harnessu uruchamia przypisany contract test wskazanego wariantu i porównuje publiczny wynik z kontraktem.

    - id: FALLBACK-01
      name: Warunek uruchomienia fallbacku
      description: Pojedynczy fallback uruchamia się dokładnie dla wskazanego warunku przewidzianego przez jawny kontrakt.
      applies_when: Artefakt dodaje lub zmienia fallback, a jawny kontrakt definiuje jeden warunek jego uruchomienia lub wykluczenia.
      pass_when:
          - Test potwierdza uruchomienie fallbacku dla wskazanego warunku włączającego albo brak uruchomienia dla wskazanego warunku wykluczonego.
      fail_when:
          - Fallback nie uruchamia się dla wskazanego warunku wymaganego przez kontrakt.
          - Fallback uruchamia się dla wskazanego warunku wykluczonego przez kontrakt.
      exceptions: []
      severity: major
      evidence_required:
          - Jawny kontrakt wskazanego warunku uruchomienia lub wykluczenia.
          - Lokalizacja predykatu fallbacku.
          - Wynik testu behawioralnego z kontrolowanym wskazanym warunkiem.
      deterministic_check: Właściciel harnessu uruchamia przypisany test predykatu fallbacku i obserwuje, czy branch został uruchomiony dla wskazanego warunku.

    - id: FALLBACK-02
      name: Publiczny wynik fallbacku
      description: Pojedynczy uruchomiony fallback zwraca publiczny wynik zadeklarowany dla wskazanego warunku.
      applies_when: Objęty fallback uruchamia się dla wskazanego warunku, a jawny kontrakt definiuje jego publiczny wynik.
      pass_when:
          - Test behawioralny obserwuje dokładnie zadeklarowany publiczny wynik fallbacku.
      fail_when:
          - Uruchomiony fallback zwraca publiczny wynik sprzeczny z jawnym kontraktem.
      exceptions:
          - Intencjonalne best-effort nie jest naruszeniem, jeśli obserwowany publiczny wynik odpowiada jego jawnemu kontraktowi.
      severity: major
      evidence_required:
          - Jawny kontrakt publicznego wyniku fallbacku dla wskazanego warunku.
          - Lokalizacja implementacji fallbacku i publicznej granicy.
          - Wynik testu behawioralnego obserwującego publiczny wynik.
      deterministic_check: Właściciel harnessu uruchamia przypisany test fallbacku z kontrolowaną odpowiedzią granicy i porównuje publiczny wynik z kontraktem.

    - id: FALLBACK-03
      name: Jeden efekt fallbacku
      description: Pojedynczy uruchomiony fallback realizuje jeden nazwany efekt zgodnie z kontraktowym oznaczeniem go jako wymaganego albo zakazanego w tym wywołaniu.
      applies_when: Objęty fallback uruchamia się dla wskazanego warunku, a jawny kontrakt definiuje jeden nazwany efekt jako wymagany albo zakazany.
      pass_when:
          - Jeśli nazwany efekt jest w tym wywołaniu wymagany, jest obserwowany po uruchomieniu fallbacku; jeśli jest zakazany, nie jest obserwowany.
      fail_when:
          - Efekt wskazany jako wymagany nie występuje po uruchomieniu fallbacku.
          - Efekt wskazany jako zakazany występuje po uruchomieniu fallbacku.
      exceptions:
          - Intencjonalne best-effort nie jest naruszeniem, jeśli nazwany efekt odpowiada jego jawnemu kontraktowi.
      severity: major
      evidence_required:
          - Jawny kontrakt jednego nazwanego efektu, w tym jego oznaczenie jako wymaganego albo zakazanego dla fallbacku.
          - Lokalizacja implementacji fallbacku i nazwanego efektu.
          - Wynik testu behawioralnego obserwującego nazwany efekt.
      deterministic_check: Właściciel harnessu uruchamia przypisany test fallbacku z kontrolowaną odpowiedzią granicy; test asercyjnie sprawdza jeden nazwany efekt zgodnie z jego oznaczeniem jako wymaganego albo zakazanego.
\`\`\`

## Kotwice kalibracyjne

- **Fallback: trigger, wynik i efekt — \`PASS\`:** kontrakt uruchamia cache po timeoutcie, zwraca ostatnią ofertę i zakazuje publikacji nowego zapisu; test wywołuje timeout, obserwuje odpowiedź z cache i brak publikacji. \`FALLBACK-01\`, \`FALLBACK-02\` i \`FALLBACK-03\` dostają osobne dowody, a \`FALLBACK-03\` ocenia tylko nazwany zakazany efekt publikacji.`,
} satisfies JudgeDefinition;
