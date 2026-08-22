# Glyph OS — pakiet PWA

Pakiet jest gotowy do publikacji jako instalowalna aplikacja internetowa.

## Zawartość

- `index.html` — aplikacja;
- `manifest.webmanifest` — dane instalacyjne PWA;
- `service-worker.js` — działanie offline i aktualizacja pamięci podręcznej;
- `offline.html` — ekran awaryjny;
- `icons/` — ikony 192 px, 512 px i wariant maskowalny.

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
