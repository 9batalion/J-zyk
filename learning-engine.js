(function () {
    'use strict';

    const DATABASE_NAME = 'glyphLearningDatabase';
    const DATABASE_VERSION = 1;
    const CARD_STORE = 'cards';
    const META_STORE = 'meta';
    const SETTINGS_KEY = 'settings';
    const EXPORT_FORMAT = 'glyph-learning-progress-v1';
    const DAY_MS = 24 * 60 * 60 * 1000;
    const MINUTE_MS = 60 * 1000;
    const MAX_IMPORT_CARDS = 500000;

    const elements = {};
    let learningDatabase = null;
    let settings = null;
    let session = null;
    let initPromise = null;
    let renderSerial = 0;

    function bindElements() {
        const ids = [
            'learningDue', 'learningNew', 'learningActive', 'learningMastered',
            'learningAccuracy', 'learningStreak', 'learningDailyText', 'learningDailyProgress',
            'learningMode', 'learningSessionSize', 'learningNewLimit', 'learningDailyGoal',
            'learningStart', 'learningReviewsOnly', 'learningStatus', 'learningStage',
            'learningSessionLabel', 'learningSessionCounter', 'learningSessionProgress',
            'learningCardState', 'learningPrompt', 'learningCanvasFrame', 'learningCanvas',
            'learningQuestionWord', 'learningAnswerRow', 'learningAnswer', 'learningCheck',
            'learningChoices', 'learningReveal', 'learningEnd', 'learningFeedback',
            'learningRating', 'learningSummary', 'learningSummaryReviewed',
            'learningSummaryCorrect', 'learningSummaryAccuracy', 'learningSummaryNew',
            'learningNextSession', 'learningExport', 'learningImport', 'learningReset',
            'learningImportFile',
        ];
        ids.forEach(id => { elements[id] = document.getElementById(id); });
    }

    function requestAsPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Operacja bazy nauki nie powiodła się.'));
        });
    }

    function transactionDone(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error('Transakcja bazy nauki nie powiodła się.'));
            transaction.onabort = () => reject(transaction.error || new Error('Transakcja bazy nauki została przerwana.'));
        });
    }

    function openDatabase() {
        if (learningDatabase) return Promise.resolve(learningDatabase);
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                const cardStore = database.objectStoreNames.contains(CARD_STORE)
                    ? request.transaction.objectStore(CARD_STORE)
                    : database.createObjectStore(CARD_STORE, { keyPath: 'key' });
                if (!cardStore.indexNames.contains('due')) cardStore.createIndex('due', 'due', { unique: false });
                if (!cardStore.indexNames.contains('state')) cardStore.createIndex('state', 'state', { unique: false });
                if (!cardStore.indexNames.contains('updatedAt')) cardStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                if (!database.objectStoreNames.contains(META_STORE)) {
                    database.createObjectStore(META_STORE, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => {
                learningDatabase = request.result;
                learningDatabase.onversionchange = () => {
                    learningDatabase.close();
                    learningDatabase = null;
                };
                resolve(learningDatabase);
            };
            request.onerror = () => reject(request.error || new Error('Nie można otworzyć bazy postępu.'));
            request.onblocked = () => reject(new Error('Baza nauki jest otwarta w innej karcie.'));
        });
    }

    async function getMeta(key) {
        const database = await openDatabase();
        const transaction = database.transaction(META_STORE, 'readonly');
        return requestAsPromise(transaction.objectStore(META_STORE).get(key));
    }

    async function putMeta(record) {
        const database = await openDatabase();
        const transaction = database.transaction(META_STORE, 'readwrite');
        transaction.objectStore(META_STORE).put(record);
        await transactionDone(transaction);
    }

    async function getCard(key) {
        const database = await openDatabase();
        const transaction = database.transaction(CARD_STORE, 'readonly');
        return requestAsPromise(transaction.objectStore(CARD_STORE).get(key));
    }

    async function putCard(card) {
        const database = await openDatabase();
        const transaction = database.transaction(CARD_STORE, 'readwrite');
        transaction.objectStore(CARD_STORE).put(card);
        await transactionDone(transaction);
    }

    async function getAllCards() {
        const database = await openDatabase();
        const transaction = database.transaction(CARD_STORE, 'readonly');
        return requestAsPromise(transaction.objectStore(CARD_STORE).getAll());
    }

    async function getDueCards(limit) {
        const database = await openDatabase();
        const transaction = database.transaction(CARD_STORE, 'readonly');
        const store = transaction.objectStore(CARD_STORE);
        const records = await requestAsPromise(
            store.index('due').getAll(IDBKeyRange.upperBound(Date.now()), Math.max(limit * 4, limit)),
        );
        return records
            .filter(card => card && card.state !== 'suspended' && Number(card.due) <= Date.now())
            .sort((left, right) => Number(left.due) - Number(right.due))
            .slice(0, limit);
    }

    async function putCardsInBatches(cards) {
        const database = await openDatabase();
        for (let offset = 0; offset < cards.length; offset += 500) {
            const transaction = database.transaction(CARD_STORE, 'readwrite');
            const store = transaction.objectStore(CARD_STORE);
            cards.slice(offset, offset + 500).forEach(card => store.put(card));
            await transactionDone(transaction);
        }
    }

    function defaultSettings() {
        return {
            key: SETTINGS_KEY,
            mode: 'mixed',
            sessionSize: 20,
            newLimit: 10,
            dailyGoal: 20,
            streak: 0,
            lastStudyDate: '',
            daily: {},
            updatedAt: Date.now(),
        };
    }

    function normalizedSettings(value) {
        const defaults = defaultSettings();
        const source = value && typeof value === 'object' ? value : {};
        const allowedModes = new Set(['mixed', 'symbol-to-word', 'word-to-symbol']);
        return {
            ...defaults,
            ...source,
            key: SETTINGS_KEY,
            mode: allowedModes.has(source.mode) ? source.mode : defaults.mode,
            sessionSize: [10, 20, 30, 50].includes(Number(source.sessionSize)) ? Number(source.sessionSize) : defaults.sessionSize,
            newLimit: [5, 10, 20].includes(Number(source.newLimit)) ? Number(source.newLimit) : defaults.newLimit,
            dailyGoal: [10, 20, 30, 50].includes(Number(source.dailyGoal)) ? Number(source.dailyGoal) : defaults.dailyGoal,
            streak: Math.max(0, Number(source.streak) || 0),
            daily: source.daily && typeof source.daily === 'object' ? source.daily : {},
        };
    }

    function localDayKey(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function previousDayKey() {
        const date = new Date();
        date.setDate(date.getDate() - 1);
        return localDayKey(date);
    }

    function dictionaryCount() {
        try {
            return typeof getTotalDictionaryCount === 'function' ? getTotalDictionaryCount() : 0;
        } catch (error) {
            return 0;
        }
    }

    function dictionaryEntry(word) {
        try {
            return typeof findWord === 'function' ? findWord(db, word) : null;
        } catch (error) {
            return null;
        }
    }

    function randomDictionaryEntry() {
        const localEntries = typeof db !== 'undefined' && Array.isArray(db.words) ? db.words : [];
        const bulkCount = globalThis.GlyphBulk?.count?.() || 0;
        const total = localEntries.length + bulkCount;
        if (total === 0) return null;
        const useBulk = bulkCount > 0 && (localEntries.length === 0 || Math.random() < bulkCount / total);
        if (useBulk) return globalThis.GlyphBulk.randomWord();
        return localEntries[Math.floor(Math.random() * localEntries.length)] || globalThis.GlyphBulk?.randomWord?.() || null;
    }

    function makeNewCard(entry) {
        const now = Date.now();
        return {
            key: normalizeDictionaryKey(entry.word),
            word: entry.word,
            state: 'new',
            due: now,
            intervalDays: 0,
            ease: 2.5,
            repetitions: 0,
            lapses: 0,
            totalReviews: 0,
            correctAnswers: 0,
            wrongAnswers: 0,
            lastGrade: null,
            lastReviewedAt: null,
            createdAt: now,
            updatedAt: now,
        };
    }

    function applySchedule(card, grade, answerWasCorrect) {
        const now = Date.now();
        const currentInterval = Math.max(0, Number(card.intervalDays) || 0);
        const currentEase = Math.min(3.2, Math.max(1.3, Number(card.ease) || 2.5));
        card.totalReviews = Math.max(0, Number(card.totalReviews) || 0) + 1;
        card.correctAnswers = Math.max(0, Number(card.correctAnswers) || 0) + (answerWasCorrect ? 1 : 0);
        card.wrongAnswers = Math.max(0, Number(card.wrongAnswers) || 0) + (answerWasCorrect ? 0 : 1);
        card.lastGrade = grade;
        card.lastReviewedAt = now;

        if (grade === 0) {
            card.repetitions = 0;
            card.lapses = Math.max(0, Number(card.lapses) || 0) + 1;
            card.ease = Math.max(1.3, currentEase - 0.2);
            card.intervalDays = 10 / (24 * 60);
        } else if (grade === 1) {
            card.repetitions = Math.max(1, (Number(card.repetitions) || 0) + 1);
            card.ease = Math.max(1.3, currentEase - 0.12);
            card.intervalDays = currentInterval < 1 ? 0.5 : Math.max(1, currentInterval * 1.25);
        } else if (grade === 2) {
            card.repetitions = (Number(card.repetitions) || 0) + 1;
            card.ease = currentEase;
            if (card.repetitions === 1) card.intervalDays = 1;
            else if (card.repetitions === 2) card.intervalDays = 3;
            else card.intervalDays = Math.max(3, currentInterval * currentEase);
        } else {
            card.repetitions = (Number(card.repetitions) || 0) + 1;
            card.ease = Math.min(3.2, currentEase + 0.12);
            card.intervalDays = card.repetitions === 1
                ? 4
                : Math.max(4, currentInterval * card.ease * 1.3);
        }

        card.intervalDays = Math.min(3650, Math.max(10 / (24 * 60), card.intervalDays));
        card.due = Math.round(now + card.intervalDays * DAY_MS);
        card.state = card.intervalDays >= 30 && card.repetitions >= 5
            ? 'mastered'
            : (card.intervalDays < 1 ? 'learning' : 'review');
        card.updatedAt = now;
        return card;
    }

    async function recordDailyReview(answerWasCorrect, wasNew) {
        const today = localDayKey();
        const day = settings.daily[today] || { reviews: 0, correct: 0, newCards: 0 };
        if (day.reviews === 0) {
            if (settings.lastStudyDate === previousDayKey()) settings.streak += 1;
            else if (settings.lastStudyDate !== today) settings.streak = 1;
        }
        day.reviews += 1;
        day.correct += answerWasCorrect ? 1 : 0;
        day.newCards += wasNew ? 1 : 0;
        settings.daily[today] = day;
        settings.lastStudyDate = today;
        settings.updatedAt = Date.now();

        const retainedDays = Object.keys(settings.daily).sort().slice(-90);
        settings.daily = Object.fromEntries(retainedDays.map(key => [key, settings.daily[key]]));
        await putMeta(settings);
    }

    function setStatus(message, type = '') {
        elements.learningStatus.textContent = message;
        elements.learningStatus.className = `learning-status${type ? ` ${type}` : ''}`;
    }

    function setFeedback(message, type = '') {
        elements.learningFeedback.textContent = message;
        elements.learningFeedback.className = `learning-feedback${type ? ` ${type}` : ''}`;
    }

    function formatNumber(value) {
        return Math.max(0, Number(value) || 0).toLocaleString('pl-PL');
    }

    async function calculateStats() {
        const cards = await getAllCards();
        const now = Date.now();
        let due = 0;
        let mastered = 0;
        let correct = 0;
        let wrong = 0;
        cards.forEach(card => {
            if (card.state !== 'suspended' && Number(card.due) <= now) due += 1;
            if (card.state === 'mastered') mastered += 1;
            correct += Math.max(0, Number(card.correctAnswers) || 0);
            wrong += Math.max(0, Number(card.wrongAnswers) || 0);
        });
        const today = settings.daily[localDayKey()] || { reviews: 0, correct: 0, newCards: 0 };
        return {
            cards: cards.length,
            due,
            mastered,
            active: Math.max(0, cards.length - mastered),
            newCount: Math.max(0, dictionaryCount() - cards.length),
            accuracy: correct + wrong > 0 ? Math.round(correct * 100 / (correct + wrong)) : null,
            today,
            streak: settings.streak || 0,
        };
    }

    async function renderStats() {
        if (!settings || !learningDatabase) return;
        const stats = await calculateStats();
        elements.learningDue.textContent = formatNumber(stats.due);
        elements.learningNew.textContent = formatNumber(stats.newCount);
        elements.learningActive.textContent = formatNumber(stats.active);
        elements.learningMastered.textContent = formatNumber(stats.mastered);
        elements.learningAccuracy.textContent = stats.accuracy === null ? '—' : `${stats.accuracy}%`;
        elements.learningStreak.textContent = formatNumber(stats.streak);
        elements.learningDailyText.textContent = `${formatNumber(stats.today.reviews)} / ${formatNumber(settings.dailyGoal)} powtórek`;
        elements.learningDailyProgress.max = settings.dailyGoal;
        elements.learningDailyProgress.value = Math.min(settings.dailyGoal, stats.today.reviews);
    }

    async function saveUiSettings() {
        if (!settings) return;
        settings.mode = elements.learningMode.value;
        settings.sessionSize = Number(elements.learningSessionSize.value);
        settings.newLimit = Number(elements.learningNewLimit.value);
        settings.dailyGoal = Number(elements.learningDailyGoal.value);
        settings.updatedAt = Date.now();
        await putMeta(settings);
        await renderStats();
    }

    function applySettingsToUi() {
        elements.learningMode.value = settings.mode;
        elements.learningSessionSize.value = String(settings.sessionSize);
        elements.learningNewLimit.value = String(settings.newLimit);
        elements.learningDailyGoal.value = String(settings.dailyGoal);
    }

    async function buildSessionQueue(reviewsOnly) {
        const desired = settings.sessionSize;
        const dueCards = await getDueCards(desired * 3);
        const studiedKeys = new Set((await getAllCards()).map(card => card.key));
        const queue = [];
        const queuedKeys = new Set();

        for (const card of dueCards) {
            if (queue.length >= desired) break;
            const entry = dictionaryEntry(card.word);
            if (!entry || queuedKeys.has(card.key)) continue;
            queue.push({ entry, card, isNew: false, repeatCount: 0, exerciseMode: null });
            queuedKeys.add(card.key);
        }

        if (!reviewsOnly) {
            let newCards = 0;
            let attempts = 0;
            const maximumAttempts = Math.max(300, settings.newLimit * 120);
            while (queue.length < desired && newCards < settings.newLimit && attempts < maximumAttempts) {
                attempts += 1;
                const entry = randomDictionaryEntry();
                if (!entry) break;
                const key = normalizeDictionaryKey(entry.word);
                if (!key || queuedKeys.has(key) || studiedKeys.has(key)) continue;
                queue.push({ entry, card: makeNewCard(entry), isNew: true, repeatCount: 0, exerciseMode: null });
                queuedKeys.add(key);
                studiedKeys.add(key);
                newCards += 1;
            }
        }

        return queue;
    }

    function chooseExerciseMode(item, index) {
        if (item.exerciseMode) return item.exerciseMode;
        if (settings.mode !== 'mixed') return settings.mode;
        return index % 2 === 0 ? 'symbol-to-word' : 'word-to-symbol';
    }

    function shuffle(values) {
        const result = values.slice();
        for (let index = result.length - 1; index > 0; index -= 1) {
            const other = Math.floor(Math.random() * (index + 1));
            [result[index], result[other]] = [result[other], result[index]];
        }
        return result;
    }

    function renderEntryOnCanvas(canvas, entry) {
        if (!canvas || !entry) return;
        const strokes = getEntryGlyph(entry);
        renderGlyph(canvas, strokes, false, 0);
    }

    function cardStateLabel(item) {
        if (item.repeatCount > 0) return 'Powtórka w sesji';
        if (item.isNew || item.card.state === 'new') return 'Nowy znak';
        if (item.card.state === 'mastered') return 'Utrwalenie';
        return 'Zaplanowana powtórka';
    }

    async function createChoiceEntries(target) {
        const choices = [target];
        const used = new Set([normalizeDictionaryKey(target.word)]);
        let attempts = 0;
        while (choices.length < 4 && attempts < 250) {
            attempts += 1;
            const entry = randomDictionaryEntry();
            if (!entry) break;
            const key = normalizeDictionaryKey(entry.word);
            if (!key || used.has(key)) continue;
            used.add(key);
            choices.push(entry);
        }
        return shuffle(choices);
    }

    async function renderChoices(item, token) {
        const choices = await createChoiceEntries(item.entry);
        if (token !== renderSerial || !session) return;
        if (choices.length < 2) {
            item.exerciseMode = 'symbol-to-word';
            await renderCurrentQuestion();
            return;
        }

        elements.learningChoices.replaceChildren();
        choices.forEach((entry, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'learning-choice';
            button.dataset.key = normalizeDictionaryKey(entry.word);
            button.setAttribute('aria-label', `Wariant ${index + 1}`);
            const canvas = document.createElement('canvas');
            canvas.width = 160;
            canvas.height = 160;
            button.appendChild(canvas);
            renderEntryOnCanvas(canvas, entry);
            button.addEventListener('click', () => selectChoice(button));
            elements.learningChoices.appendChild(button);
        });
    }

    function resetAnswerUi() {
        elements.learningAnswer.value = '';
        elements.learningAnswer.disabled = false;
        elements.learningCheck.disabled = false;
        elements.learningReveal.disabled = false;
        elements.learningRating.hidden = true;
        elements.learningRating.querySelectorAll('button').forEach(button => { button.disabled = false; });
        elements.learningChoices.replaceChildren();
        setFeedback('Odpowiedz bez pośpiechu — liczy się trwałe zapamiętanie.');
    }

    async function renderCurrentQuestion() {
        if (!session || session.index >= session.queue.length) {
            await finishSession();
            return;
        }
        const token = ++renderSerial;
        const item = session.queue[session.index];
        item.exerciseMode = chooseExerciseMode(item, session.index);
        session.answered = false;
        session.answerWasCorrect = false;
        session.selectedChoiceKey = '';
        resetAnswerUi();

        elements.learningSessionCounter.textContent = `${session.index + 1} / ${session.queue.length}`;
        elements.learningSessionProgress.max = Math.max(1, session.queue.length);
        elements.learningSessionProgress.value = session.index;
        elements.learningCardState.textContent = cardStateLabel(item);

        if (item.exerciseMode === 'word-to-symbol') {
            elements.learningPrompt.textContent = 'Wybierz znak odpowiadający temu słowu';
            elements.learningQuestionWord.textContent = item.entry.word;
            elements.learningQuestionWord.hidden = false;
            elements.learningCanvasFrame.hidden = true;
            elements.learningAnswerRow.hidden = true;
            elements.learningChoices.hidden = false;
            await renderChoices(item, token);
        } else {
            elements.learningPrompt.textContent = 'Co oznacza ten znak?';
            elements.learningQuestionWord.hidden = true;
            elements.learningCanvasFrame.hidden = false;
            elements.learningAnswerRow.hidden = false;
            elements.learningChoices.hidden = true;
            renderEntryOnCanvas(elements.learningCanvas, item.entry);
            requestAnimationFrame(() => elements.learningAnswer.focus());
        }
    }

    async function startSession(reviewsOnly = false) {
        if (!learningDatabase) return;
        await saveUiSettings();
        elements.learningStart.disabled = true;
        elements.learningReviewsOnly.disabled = true;
        elements.learningSummary.hidden = true;
        setStatus(reviewsOnly ? 'Przygotowuję zaległe powtórki…' : 'Układam sesję: najpierw zaległe znaki, potem nowe…');
        try {
            await globalThis.GlyphBulk?.ready?.();
            if (dictionaryCount() === 0) {
                setStatus('Baza znaków jest pusta. Najpierw zapisz znaki lub wczytaj paczkę słownika.', 'warning');
                return;
            }
            const queue = await buildSessionQueue(reviewsOnly);
            if (queue.length === 0) {
                setStatus(
                    reviewsOnly
                        ? 'Nie masz teraz zaległych powtórek. Możesz rozpocząć zwykłą sesję z nowymi znakami.'
                        : 'Nie udało się znaleźć nowych ani zaległych znaków do tej sesji.',
                    'success',
                );
                return;
            }
            session = {
                queue,
                index: 0,
                reviewsOnly,
                startedAt: Date.now(),
                answered: false,
                answerWasCorrect: false,
                selectedChoiceKey: '',
                stats: { reviewed: 0, correct: 0, newCards: 0 },
            };
            elements.learningSessionLabel.textContent = reviewsOnly ? 'Sesja powtórek' : 'Sesja nauki';
            elements.learningStage.hidden = false;
            setStatus(`Sesja gotowa: ${queue.length} ${queue.length === 1 ? 'karta' : 'kart'}.`, 'success');
            await renderCurrentQuestion();
            elements.learningStage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (error) {
            console.error('Nie udało się rozpocząć nauki:', error);
            setStatus(`Nie udało się rozpocząć sesji: ${error.message}`, 'warning');
        } finally {
            const active = Boolean(session);
            elements.learningStart.disabled = active;
            elements.learningReviewsOnly.disabled = active;
        }
    }

    function revealAnswer(answerWasCorrect, selectedKey = '') {
        if (!session || session.answered) return;
        const item = session.queue[session.index];
        const answer = item.entry.word;
        session.answered = true;
        session.answerWasCorrect = Boolean(answerWasCorrect);
        session.selectedChoiceKey = selectedKey;
        elements.learningAnswer.disabled = true;
        elements.learningCheck.disabled = true;
        elements.learningReveal.disabled = true;

        if (item.exerciseMode === 'word-to-symbol') {
            elements.learningChoices.querySelectorAll('.learning-choice').forEach(button => {
                const isTarget = button.dataset.key === normalizeDictionaryKey(answer);
                const isSelected = button.dataset.key === selectedKey;
                button.disabled = true;
                button.classList.toggle('correct', isTarget);
                button.classList.toggle('incorrect', isSelected && !isTarget);
            });
        }

        if (answerWasCorrect) {
            setFeedback(`Poprawnie: „${answer}”. Oceń, jak łatwo udało Ci się przypomnieć znak.`, 'correct');
        } else {
            setFeedback(`Prawidłowa odpowiedź: „${answer}” (${[...answer].length} znaków). Ten glif wróci jeszcze w tej sesji.`, 'incorrect');
        }

        elements.learningRating.hidden = false;
        elements.learningRating.querySelectorAll('button').forEach(button => {
            const grade = Number(button.dataset.grade);
            button.disabled = !answerWasCorrect && grade >= 2;
        });
        const focusGrade = answerWasCorrect ? '2' : '0';
        elements.learningRating.querySelector(`[data-grade="${focusGrade}"]`)?.focus();
    }

    function checkTypedAnswer() {
        if (!session || session.answered) return;
        const guess = elements.learningAnswer.value.trim();
        if (!guess) {
            setFeedback('Wpisz odpowiedź albo użyj przycisku „Pokaż odpowiedź”.', 'incorrect');
            elements.learningAnswer.focus();
            return;
        }
        const target = session.queue[session.index].entry.word;
        revealAnswer(normalizeDictionaryKey(guess) === normalizeDictionaryKey(target));
    }

    function selectChoice(button) {
        if (!session || session.answered) return;
        elements.learningChoices.querySelectorAll('.learning-choice').forEach(choice => choice.classList.remove('selected'));
        button.classList.add('selected');
        const selectedKey = button.dataset.key || '';
        const targetKey = normalizeDictionaryKey(session.queue[session.index].entry.word);
        revealAnswer(selectedKey === targetKey, selectedKey);
    }

    function intervalLabel(card) {
        const minutes = Math.round(card.intervalDays * 24 * 60);
        if (minutes < 60) return `za ${Math.max(1, minutes)} min`;
        const hours = Math.round(minutes / 60);
        if (hours < 24) return `za ${hours} godz.`;
        const days = Math.round(card.intervalDays);
        if (days === 1) return 'jutro';
        if (days < 30) return `za ${days} dni`;
        const months = Math.max(1, Math.round(days / 30));
        return `za około ${months} mies.`;
    }

    async function rateCurrent(grade) {
        if (!session || !session.answered) return;
        const item = session.queue[session.index];
        if (!session.answerWasCorrect && grade >= 2) return;
        elements.learningRating.querySelectorAll('button').forEach(button => { button.disabled = true; });
        const wasNew = (Number(item.card.totalReviews) || 0) === 0;
        applySchedule(item.card, grade, session.answerWasCorrect);
        await putCard(item.card);
        await recordDailyReview(session.answerWasCorrect, wasNew);

        session.stats.reviewed += 1;
        session.stats.correct += session.answerWasCorrect ? 1 : 0;
        session.stats.newCards += wasNew ? 1 : 0;

        if (grade === 0 && item.repeatCount < 2) {
            session.queue.push({
                entry: item.entry,
                card: item.card,
                isNew: false,
                repeatCount: item.repeatCount + 1,
                exerciseMode: null,
            });
        }

        setStatus(`Zapisano odpowiedź. Następna planowana powtórka: ${intervalLabel(item.card)}.`, 'success');
        session.index += 1;
        await renderStats();
        await renderCurrentQuestion();
    }

    async function finishSession() {
        if (!session) return;
        const stats = session.stats;
        const reviewed = stats.reviewed;
        const accuracy = reviewed > 0 ? Math.round(stats.correct * 100 / reviewed) : 0;
        elements.learningStage.hidden = true;
        elements.learningSummary.hidden = false;
        elements.learningSummaryReviewed.textContent = formatNumber(reviewed);
        elements.learningSummaryCorrect.textContent = formatNumber(stats.correct);
        elements.learningSummaryAccuracy.textContent = reviewed > 0 ? `${accuracy}%` : '—';
        elements.learningSummaryNew.textContent = formatNumber(stats.newCards);
        setStatus(
            reviewed > 0
                ? `Sesja zakończona. Oceniono ${reviewed} odpowiedzi, skuteczność ${accuracy}%.`
                : 'Sesja zakończona bez ocenionych odpowiedzi.',
            reviewed > 0 ? 'success' : '',
        );
        session = null;
        elements.learningStart.disabled = false;
        elements.learningReviewsOnly.disabled = false;
        await renderStats();
        elements.learningSummary.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function triggerDownload(blob, filename) {
        if (typeof triggerBlobDownload === 'function') {
            triggerBlobDownload(blob, filename);
            return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function exportProgress() {
        try {
            const cards = await getAllCards();
            const payload = {
                format: EXPORT_FORMAT,
                exportedAt: new Date().toISOString(),
                settings,
                cards,
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
            triggerDownload(blob, `glyph-os-postep-${localDayKey()}.json`);
            setStatus(`Wyeksportowano postęp ${cards.length.toLocaleString('pl-PL')} znaków.`, 'success');
        } catch (error) {
            setStatus(`Nie udało się wyeksportować postępu: ${error.message}`, 'warning');
        }
    }

    function sanitizeImportedCard(source) {
        if (!source || typeof source !== 'object') return null;
        const word = String(source.word || '').normalize('NFC').trim();
        const key = normalizeDictionaryKey(source.key || word);
        if (!word || !key || [...word].length > 80) return null;
        const now = Date.now();
        const state = ['new', 'learning', 'review', 'mastered', 'suspended'].includes(source.state)
            ? source.state
            : 'review';
        return {
            key,
            word,
            state,
            due: Number.isFinite(Number(source.due)) ? Number(source.due) : now,
            intervalDays: Math.min(3650, Math.max(0, Number(source.intervalDays) || 0)),
            ease: Math.min(3.2, Math.max(1.3, Number(source.ease) || 2.5)),
            repetitions: Math.max(0, Number(source.repetitions) || 0),
            lapses: Math.max(0, Number(source.lapses) || 0),
            totalReviews: Math.max(0, Number(source.totalReviews) || 0),
            correctAnswers: Math.max(0, Number(source.correctAnswers) || 0),
            wrongAnswers: Math.max(0, Number(source.wrongAnswers) || 0),
            lastGrade: source.lastGrade === null ? null : Math.min(3, Math.max(0, Number(source.lastGrade) || 0)),
            lastReviewedAt: Number(source.lastReviewedAt) || null,
            createdAt: Number(source.createdAt) || now,
            updatedAt: Number(source.updatedAt) || now,
        };
    }

    async function importProgress(file) {
        elements.learningImport.disabled = true;
        try {
            const payload = JSON.parse(await file.text());
            if (payload?.format !== EXPORT_FORMAT || !Array.isArray(payload.cards)) {
                throw new Error('To nie jest plik postępu Akademii Glifów.');
            }
            if (payload.cards.length > MAX_IMPORT_CARDS) {
                throw new Error(`Plik przekracza limit ${MAX_IMPORT_CARDS.toLocaleString('pl-PL')} kart.`);
            }
            const unique = new Map();
            payload.cards.forEach(source => {
                const card = sanitizeImportedCard(source);
                if (card) unique.set(card.key, card);
            });
            await putCardsInBatches([...unique.values()]);
            if (payload.settings && typeof payload.settings === 'object') {
                settings = normalizedSettings(payload.settings);
                await putMeta(settings);
                applySettingsToUi();
            }
            await renderStats();
            setStatus(`Zaimportowano postęp ${unique.size.toLocaleString('pl-PL')} znaków.`, 'success');
        } catch (error) {
            console.error('Import postępu nie powiódł się:', error);
            setStatus(`Nie udało się zaimportować postępu: ${error.message}`, 'warning');
        } finally {
            elements.learningImport.disabled = false;
        }
    }

    async function resetProgress() {
        if (!confirm('Czy na pewno usunąć cały postęp nauki, statystyki i harmonogram powtórek? Baza znaków pozostanie bez zmian.')) return;
        elements.learningReset.disabled = true;
        try {
            if (learningDatabase) {
                learningDatabase.close();
                learningDatabase = null;
            }
            await new Promise((resolve, reject) => {
                const request = indexedDB.deleteDatabase(DATABASE_NAME);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error || new Error('Nie udało się usunąć bazy postępu.'));
                request.onblocked = () => reject(new Error('Zamknij inne karty aplikacji i spróbuj ponownie.'));
            });
            session = null;
            elements.learningStage.hidden = true;
            elements.learningSummary.hidden = true;
            await openDatabase();
            settings = defaultSettings();
            await putMeta(settings);
            applySettingsToUi();
            await renderStats();
            setStatus('Postęp nauki został wyczyszczony. Baza znaków nie została zmieniona.', 'success');
        } catch (error) {
            setStatus(`Nie udało się wyczyścić postępu: ${error.message}`, 'warning');
        } finally {
            elements.learningReset.disabled = false;
        }
    }

    function bindEvents() {
        elements.learningStart.addEventListener('click', () => startSession(false));
        elements.learningReviewsOnly.addEventListener('click', () => startSession(true));
        elements.learningNextSession.addEventListener('click', () => startSession(false));
        elements.learningCheck.addEventListener('click', checkTypedAnswer);
        elements.learningAnswer.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                checkTypedAnswer();
            }
        });
        elements.learningReveal.addEventListener('click', () => revealAnswer(false));
        elements.learningEnd.addEventListener('click', finishSession);
        elements.learningRating.addEventListener('click', event => {
            const button = event.target.closest('button[data-grade]');
            if (button && !button.disabled) rateCurrent(Number(button.dataset.grade));
        });
        [elements.learningMode, elements.learningSessionSize, elements.learningNewLimit, elements.learningDailyGoal]
            .forEach(select => select.addEventListener('change', saveUiSettings));
        elements.learningExport.addEventListener('click', exportProgress);
        elements.learningImport.addEventListener('click', () => elements.learningImportFile.click());
        elements.learningImportFile.addEventListener('change', event => {
            const file = event.target.files?.[0];
            if (file) importProgress(file);
            event.target.value = '';
        });
        elements.learningReset.addEventListener('click', resetProgress);
    }

    async function initialize() {
        bindElements();
        bindEvents();
        if (!('indexedDB' in window)) {
            setStatus('Ta przeglądarka nie obsługuje IndexedDB. Moduł nauki jest niedostępny.', 'warning');
            elements.learningStart.disabled = true;
            elements.learningReviewsOnly.disabled = true;
            return;
        }
        try {
            const canvasContext = elements.learningCanvas.getContext('2d');
            paintPaper(canvasContext, elements.learningCanvas.width, elements.learningCanvas.height);
            await openDatabase();
            settings = normalizedSettings(await getMeta(SETTINGS_KEY));
            await putMeta(settings);
            applySettingsToUi();
            await renderStats();
            setStatus('Silnik powtórek gotowy. Wczytuję pełny indeks słownika…');
            await globalThis.GlyphBulk?.ready?.();
            await renderStats();
            const count = dictionaryCount();
            setStatus(
                count > 0
                    ? `Gotowe do nauki: ${count.toLocaleString('pl-PL')} znaków w bazie.`
                    : 'Baza znaków jest pusta. Zapisz własne znaki lub dodaj paczkę słownika.',
                count > 0 ? 'success' : 'warning',
            );
        } catch (error) {
            console.error('Inicjalizacja silnika nauki nie powiodła się:', error);
            setStatus(`Silnik nauki nie został uruchomiony: ${error.message}`, 'warning');
        }
    }

    function ready() {
        return initPromise;
    }

    async function refresh() {
        if (initPromise) await initPromise;
        await renderStats();
    }

    globalThis.GlyphLearning = {
        ready,
        refresh,
        getStats: calculateStats,
        startSession,
    };

    initPromise = initialize();
}());
