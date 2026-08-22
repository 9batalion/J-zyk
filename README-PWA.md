# Glyph OS — pakiet PWA

Pakiet jest gotowy do publikacji jako instalowalna aplikacja internetowa.

## Zawartość

- `index.html` — aplikacja;
- `manifest.webmanifest` — dane instalacyjne PWA;
- `service-worker.js` — działanie offline i aktualizacja pamięci podręcznej;
- `offline.html` — ekran awaryjny;
- `icons/` — ikony 192 px, 512 px i wariant maskowalny.
- `vendor/` — lokalne parsery ZIP/DOCX/ODT i PDF używane również offline.

## Publikacja

1. Wgraj całą zawartość katalogu na hosting HTTPS, zachowując strukturę plików.
2. W GitHub Pages plik `index.html` powinien znajdować się w katalogu głównym publikowanej gałęzi.
3. Po pierwszym uruchomieniu odśwież stronę, aby service worker przejął aplikację.
4. Chrome i Edge pokażą przycisk `Zainstaluj aplikację`, gdy spełnione są warunki PWA.

## Instalacja na iPhone

Otwórz stronę w Safari, wybierz `Udostępnij`, następnie `Do ekranu początkowego`.

## Dane użytkownika

Baza symboli jest przechowywana lokalnie w przeglądarce. Aktualizacja plików PWA nie usuwa bazy, ale wyczyszczenie danych witryny lub odinstalowanie aplikacji może ją skasować. Warto regularnie używać przycisku `Eksportuj bazę`.

Na ekranie głównym baza pokazuje maksymalnie 9 ostatnio zapisanych znaków. Pole wyszukiwania nad galerią przeszukuje całą bazę i pokazuje wszystkie pasujące słowa.

## Generator i rozpoznawanie

Generator V9 korzysta z geometrycznego alfabetu inspirowanego materiałem wzorcowym. Rdzenie są budowane wyłącznie z odcinków poziomych, pionowych i ukośnych pod kątem 45°. Czytelne pierścienie trafiają na wolne końce, a osobne grupy równoległych kresek, kropek i małych kątów działają jako diakrytyki. Długość słowa steruje liczbą gałęzi, zakończeń i dodatków: znak jednej litery pozostaje prosty, a długiego słowa jest wyraźnie bardziej złożony.

Silnik rozpoznawania porównuje znormalizowane mapy binarne 40×40 i odrzuca niejednoznaczne dopasowania zamiast automatycznie wpisywać błędne słowo. Dla baz liczących ponad 1000 i 5000 słów stosowane są stopniowo ostrzejsze progi przewagi najlepszego wyniku.

## Tekst obrazkowy

Generator zdań układa zapisane symbole jak glify własnej czcionki: w równych wierszach, bez kafelków, ramek i numerów, z odstępami pomiędzy słowami oraz interpunkcją dosuniętą do poprzedniego znaku. Zapis automatycznie przechodzi do następnego wiersza. Eksportowane PNG zachowuje metadane zdania, a sam widoczny układ może być również odczytany przez tryb swobodnej mapy binarnej.

## Dokumenty obrazkowe

Moduł `Koder Dokumentów` przyjmuje tekst wklejony ręcznie oraz pliki TXT, MD, CSV, JSON, LOG, HTML, DOCX, ODT i PDF z warstwą tekstową. Tworzy wielostronicowy plik `.glyphdoc`, który jest archiwum ZIP bez kompresji zawierającym strony PNG, manifest `document.json` oraz — gdy dokument został wczytany z pliku — dokładną kopię oryginału. Po odkodowaniu użytkownik może pobrać tekst UTF-8 albo oryginalny DOCX, ODT, PDF, HTML lub inny obsługiwany plik.

Dokument może zawierać maksymalnie 250 000 znaków, 20 000 elementów i 250 stron symbolicznych. Plik źródłowy może mieć do 100 MB, a archiwum `.glyphdoc` do 200 MB. Wszystkie słowa muszą wcześniej istnieć w bazie. Wyszukiwanie glifów jest niewrażliwe na wielkość liter: `Dom`, `dom` i `DOM` wskazują ten sam symbol, ale podczas dokładnego odkodowania aplikacja przywraca oryginalną pisownię, akapity i polskie znaki. Gdy metadanych brakuje, aplikacja próbuje odczytać stronę za pomocą map binarnych.

PDF bez warstwy tekstowej wymaga OCR i nie jest jeszcze przetwarzany. Stary binarny format DOC należy wcześniej zapisać jako DOCX. Pełna treść dużego dokumentu jest osadzana w manifeście oraz na pierwszej stronie PNG; pozostałe strony przechowują własny tekst strony, co ogranicza zużycie pamięci.
