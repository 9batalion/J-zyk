# Wdrożenie Glyph OS na GitHub Pages

## Co wykazały logi

Kompilacja z 22 sierpnia 2026 r. zakończyła się powodzeniem. GitHub utworzył i wysłał artefakt `github-pages`. Ostrzeżenia dotyczą Node.js używanego wewnętrznie przez akcję GitHub i nie są błędem aplikacji.

Repozytorium było jednak przetwarzane przez Jekyll, mimo że Glyph OS jest zwykłą aplikacją statyczną. Plik `.nojekyll` dołączony do tej wersji wyłącza to przetwarzanie i każe GitHub Pages publikować pliki bez zmian.

## Aktualizacja repozytorium

1. Rozpakuj najnowszą paczkę projektu Glyph OS.
2. Wgraj do głównego katalogu gałęzi `main` całą zawartość archiwum, łącznie z ukrytym plikiem `.nojekyll`.
3. Zachowaj katalogi `icons` i `vendor` — nie przenoś ich zawartości do katalogu głównego.
4. W ustawieniach repozytorium otwórz `Settings` → `Pages`.
5. Ustaw źródło publikacji na gałąź `main` i katalog `/ (root)`.
6. Poczekaj na zakończenie nowego wdrożenia, a następnie otwórz stronę projektu.

Dla repozytorium `9batalion/J-zyk` domyślny adres projektu to:

`https://9batalion.github.io/J-zyk/`

## Stare duplikaty do usunięcia

Log pokazał dodatkowe kopie ikon w katalogu głównym. Jeżeli nadal znajdują się w repozytorium, usuń tylko te stare duplikaty:

- `icon-192.png`
- `icon-512.png`
- `icon-maskable-512.png`
- `icon-source.svg`

Prawidłowe wersje pozostają w katalogu `icons/`. Nie usuwaj plików o tych nazwach z katalogu `icons/`.

W logu były też obce pliki `icons/Redm` i `vendor/Readme`. Jeżeli nie zostały dodane celowo, można je usunąć. Nie są wymagane przez aplikację.

## Gdy telefon nadal pokazuje starą wersję

Service worker może przez krótki czas wyświetlać poprzednią wersję PWA. Zamknij wszystkie karty aplikacji, uruchom ją ponownie i odśwież stronę. Jeżeli to nie pomoże, usuń aplikację z ekranu początkowego, otwórz stronę w Safari albo Chrome i zainstaluj ją ponownie. Baza IndexedDB zwykle pozostaje w danych witryny, ale przed czyszczeniem danych przeglądarki warto wyeksportować ważne znaki.
