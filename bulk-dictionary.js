(function () {
    'use strict';

    const DATABASE_NAME = 'glyphLanguageMassDatabase';
    const DATABASE_VERSION = 2;
    const WORD_STORE = 'words';
    const SIGNATURE_STORE = 'signatures';
    const PNG_STORE = 'png';
    const META_STORE = 'meta';
    const IMPORT_JOB_KEY = 'import-job';
    const PNG_JOB_KEY = 'png-job';
    const ZIP_CURSOR_KEY = 'zip-cursor';
    const IMPORT_BATCH_SIZE = 48;
    const PNG_BATCH_SIZE = 6;
    const MAX_IMPORT_WORDS_PER_FILE = 200000;
    const MAX_IMPORT_FILE_SIZE = 100 * 1024 * 1024;
    const MAX_BACKUP_WORDS = 500000;
    const ZIP_BATCH_SIZE = 500;

    let database = null;
    let initializePromise = null;
    let importLoopToken = 0;
    let pngLoopToken = 0;
    let importPaused = true;
    let pngPaused = true;
    const words = new Map();

    const elements = {};

    function requestAsPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Operacja IndexedDB nie powiodła się.'));
        });
    }

    function transactionDone(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error('Transakcja IndexedDB nie powiodła się.'));
            transaction.onabort = () => reject(transaction.error || new Error('Transakcja IndexedDB została przerwana.'));
        });
    }

    function openDatabase() {
        if (database) return Promise.resolve(database);
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
            request.onupgradeneeded = () => {
                const dbHandle = request.result;
                const wordStore = dbHandle.objectStoreNames.contains(WORD_STORE)
                    ? request.transaction.objectStore(WORD_STORE)
                    : dbHandle.createObjectStore(WORD_STORE, { keyPath: 'key' });
                if (!wordStore.indexNames.contains('importedAt')) {
                    wordStore.createIndex('importedAt', 'importedAt', { unique: false });
                }
                const signatureStore = dbHandle.objectStoreNames.contains(SIGNATURE_STORE)
                    ? request.transaction.objectStore(SIGNATURE_STORE)
                    : dbHandle.createObjectStore(SIGNATURE_STORE, { keyPath: 'key' });
                ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10', 'l11', 'exactHash', 'inkBucket']
                    .forEach(indexName => {
                        if (!signatureStore.indexNames.contains(indexName)) {
                            signatureStore.createIndex(indexName, indexName, { unique: false });
                        }
                    });
                if (!dbHandle.objectStoreNames.contains(PNG_STORE)) {
                    dbHandle.createObjectStore(PNG_STORE, { keyPath: 'key' });
                }
                if (!dbHandle.objectStoreNames.contains(META_STORE)) {
                    dbHandle.createObjectStore(META_STORE, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => {
                database = request.result;
                database.onversionchange = () => {
                    database.close();
                    database = null;
                };
                resolve(database);
            };
            request.onerror = () => reject(request.error || new Error('Nie można otworzyć dużej bazy.'));
            request.onblocked = () => reject(new Error('Aktualizacja bazy jest zablokowana przez inną kartę aplikacji.'));
        });
    }

    async function storeCount(storeName) {
        const dbHandle = await openDatabase();
        const transaction = dbHandle.transaction(storeName, 'readonly');
        return requestAsPromise(transaction.objectStore(storeName).count());
    }

    async function getMeta(key) {
        const dbHandle = await openDatabase();
        const transaction = dbHandle.transaction(META_STORE, 'readonly');
        return requestAsPromise(transaction.objectStore(META_STORE).get(key));
    }

    async function putMeta(record) {
        const dbHandle = await openDatabase();
        const transaction = dbHandle.transaction(META_STORE, 'readwrite');
        transaction.objectStore(META_STORE).put(record);
        await transactionDone(transaction);
    }

    async function deleteMeta(key) {
        const dbHandle = await openDatabase();
        const transaction = dbHandle.transaction(META_STORE, 'readwrite');
        transaction.objectStore(META_STORE).delete(key);
        await transactionDone(transaction);
    }

    function asBulkEntry(record) {
        return {
            word: record.word,
            key: record.key,
            glyphWord: record.key,
            variantSeed: record.variantSeed,
            generatorVersion: record.generatorVersion,
            timestamp: record.importedAt,
            isBulk: true,
            sourceName: record.sourceName || '',
        };
    }

    function getWord(value) {
        return words.get(normalizeDictionaryKey(value)) || null;
    }

    function getTotalUniqueCount() {
        if (typeof db === 'undefined' || !Array.isArray(db.words)) return words.size;
        let overlap = 0;
        db.words.forEach(entry => {
            if (words.has(normalizeDictionaryKey(entry.word))) overlap++;
        });
        return words.size + db.words.length - overlap;
    }

    function searchWords(query, limit = 60, excludedKeys = new Set()) {
        const normalized = normalizeDictionaryKey(query);
        if (!normalized) return recentWords(limit, excludedKeys);
        const result = [];
        for (const [key, entry] of words) {
            if (excludedKeys.has(key) || !key.includes(normalized)) continue;
            result.push(entry);
            if (result.length >= limit) break;
        }
        return result;
    }

    function recentWords(limit = 9, excludedKeys = new Set()) {
        const result = [];
        const entries = [...words.values()];
        for (let index = entries.length - 1; index >= 0 && result.length < limit; index--) {
            const entry = entries[index];
            if (!excludedKeys.has(entry.key)) result.push(entry);
        }
        return result;
    }

    function randomWord() {
        if (words.size === 0) return null;
        const index = Math.floor(Math.random() * words.size);
        let cursor = 0;
        for (const entry of words.values()) {
            if (cursor === index) return entry;
            cursor++;
        }
        return null;
    }

    function setStatus(message, type = '') {
        if (!elements.status) return;
        elements.status.textContent = message;
        elements.status.className = `bulk-status${type ? ` ${type}` : ''}`;
    }

    function formatBytes(value) {
        if (!Number.isFinite(value) || value <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
        const amount = value / (1024 ** unit);
        return `${amount.toLocaleString('pl-PL', { maximumFractionDigits: unit < 2 ? 0 : 2 })} ${units[unit]}`;
    }

    async function refreshStorageEstimate() {
        if (!elements.storage) return;
        try {
            if (!navigator.storage?.estimate) {
                elements.storage.textContent = 'brak danych';
                return;
            }
            const estimate = await navigator.storage.estimate();
            const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
            elements.storage.textContent = `${formatBytes(estimate.usage || 0)} / ${formatBytes(estimate.quota || 0)}${persisted ? ' • trwała' : ''}`;
        } catch (error) {
            elements.storage.textContent = 'niedostępne';
        }
    }

    async function refreshStats() {
        if (!database) return;
        try {
            const [signatureCount, pngCount] = await Promise.all([
                storeCount(SIGNATURE_STORE),
                storeCount(PNG_STORE),
            ]);
            if (elements.words) elements.words.textContent = words.size.toLocaleString('pl-PL');
            if (elements.signatures) elements.signatures.textContent = signatureCount.toLocaleString('pl-PL');
            if (elements.png) elements.png.textContent = pngCount.toLocaleString('pl-PL');
            if (elements.pngProgress) {
                elements.pngProgress.max = Math.max(1, words.size);
                elements.pngProgress.value = Math.min(words.size, pngCount);
            }
            if (elements.pngProgressText) {
                elements.pngProgressText.textContent = `${pngCount.toLocaleString('pl-PL')} / ${words.size.toLocaleString('pl-PL')}`;
            }
            if (elements.pngStart) elements.pngStart.disabled = words.size === 0;
            if (elements.zip) elements.zip.disabled = pngCount === 0;
            const totalWords = getTotalUniqueCount();
            if (elements.backup) elements.backup.disabled = totalWords === 0;
            if (elements.wordList) elements.wordList.disabled = totalWords === 0;
            await refreshStorageEstimate();
        } catch (error) {
            console.warn('Nie udało się odświeżyć statystyk dużej bazy:', error);
        }
    }

    function refreshMainInterface() {
        if (typeof renderGallery === 'function') renderGallery();
        if (typeof updateWordCount === 'function') updateWordCount();
    }

    async function loadWordsIntoMemory() {
        const dbHandle = await openDatabase();
        const transaction = dbHandle.transaction(WORD_STORE, 'readonly');
        const records = await requestAsPromise(transaction.objectStore(WORD_STORE).getAll());
        words.clear();
        records.forEach(record => words.set(record.key, asBulkEntry(record)));
    }

    function deterministicSeed(key) {
        return mixSeeds(hashString(key), mixSeeds(0x4d415353, hashString(`glyph-os:${key}`)));
    }

    function packBits(bits) {
        const packed = new Uint8Array(Math.ceil(bits.length / 8));
        for (let index = 0; index < bits.length; index++) {
            if (bits[index]) packed[index >> 3] |= 1 << (index & 7);
        }
        return packed;
    }

    function unpackBits(packed) {
        const source = packed instanceof Uint8Array ? packed : new Uint8Array(packed);
        const bits = new Uint8Array(BINARY_MAP_SIZE * BINARY_MAP_SIZE);
        for (let index = 0; index < bits.length; index++) {
            bits[index] = (source[index >> 3] >> (index & 7)) & 1;
        }
        return bits;
    }

    function binaryLshKeys(map) {
        const cellSize = BINARY_MAP_SIZE / 4;
        const occupancy = new Uint8Array(16);
        for (let y = 0; y < BINARY_MAP_SIZE; y++) {
            for (let x = 0; x < BINARY_MAP_SIZE; x++) {
                if (!map.bits[y * BINARY_MAP_SIZE + x]) continue;
                const cellX = Math.min(3, Math.floor(x / cellSize));
                const cellY = Math.min(3, Math.floor(y / cellSize));
                occupancy[cellY * 4 + cellX]++;
            }
        }
        const quantized = [...occupancy].map(value => value >= 19 ? 3 : (value >= 8 ? 2 : (value >= 2 ? 1 : 0)));
        const groups = [
            [0, 1, 2, 3, 4, 5, 6, 7],
            [8, 9, 10, 11, 12, 13, 14, 15],
            [0, 2, 5, 7, 8, 10, 13, 15],
            [1, 3, 4, 6, 9, 11, 12, 14],
        ];
        const coarseKeys = groups.map(group => group.reduce((key, cell, index) => key | (quantized[cell] << (index * 2)), 0));

        // Drugi poziom korzysta z siatki 8×8. Każdy klucz obejmuje co
        // czwartą komórkę, dzięki czemu niewielkie przesunięcie kreski zwykle
        // zmienia tylko część kluczy, a nie całą krótką listę kandydatów.
        const fineGroups = [
            [0, 4, 9, 13, 18, 22, 27, 31, 32, 36, 41, 45, 50, 54, 59, 63],
            [1, 5, 8, 12, 19, 23, 26, 30, 33, 37, 40, 44, 51, 55, 58, 62],
            [2, 6, 11, 15, 16, 20, 25, 29, 34, 38, 43, 47, 48, 52, 57, 61],
            [3, 7, 10, 14, 17, 21, 24, 28, 35, 39, 42, 46, 49, 53, 56, 60],
        ];
        const hashFineGroups = fine => fineGroups.map(group => {
            let hash = 2166136261;
            group.forEach(cell => {
                hash ^= (cell << 2) | fine[cell];
                hash = Math.imul(hash, 16777619);
            });
            return hash >>> 0;
        });
        const fineA = [...map.features].map(value => value >= 8 ? 3 : (value >= 3 ? 2 : (value >= 1 ? 1 : 0)));
        const fineB = [...map.features].map(value => value >= 11 ? 3 : (value >= 5 ? 2 : (value >= 1 ? 1 : 0)));
        return [...coarseKeys, ...hashFineGroups(fineA), ...hashFineGroups(fineB)];
    }

    function binaryExactHash(map) {
        let hash = 2166136261;
        for (let index = 0; index < map.bits.length; index++) {
            hash ^= map.bits[index] ? ((index & 0xff) ^ 0xa5) : 0x3d;
            hash = Math.imul(hash, 16777619);
        }
        hash ^= Math.round(map.aspect * 1000);
        return Math.imul(hash, 16777619) >>> 0;
    }

    function createImportRecords(word, sourceName, importedAt, options = {}) {
        const key = normalizeDictionaryKey(word);
        const variantSeed = options.variantSeed !== null && options.variantSeed !== '' && Number.isFinite(Number(options.variantSeed))
            ? Number(options.variantSeed) >>> 0
            : deterministicSeed(key);
        const generatorVersion = options.generatorVersion !== null && options.generatorVersion !== '' && Number.isFinite(Number(options.generatorVersion))
            ? Number(options.generatorVersion)
            : GENERATOR_VERSION;
        const entry = {
            word: String(word).normalize('NFC').trim(),
            key,
            glyphWord: key,
            variantSeed,
            generatorVersion,
            timestamp: importedAt,
            isBulk: true,
        };
        const template = createBinaryGlyphTemplate(entry);
        const keys = binaryLshKeys(template.map);
        return {
            word: {
                key,
                word: entry.word,
                variantSeed,
                generatorVersion,
                importedAt,
                sourceName,
            },
            signature: {
                key,
                packedBits: packBits(template.map.bits),
                features: new Uint16Array(template.map.features),
                count: template.map.count,
                aspect: template.map.aspect,
                fingerprint: template.fingerprint,
                l0: keys[0],
                l1: keys[1],
                l2: keys[2],
                l3: keys[3],
                l4: keys[4],
                l5: keys[5],
                l6: keys[6],
                l7: keys[7],
                l8: keys[8],
                l9: keys[9],
                l10: keys[10],
                l11: keys[11],
                exactHash: binaryExactHash(template.map),
                inkBucket: Math.round(template.map.count / 18),
            },
            entry,
        };
    }

    function normalizeImportedWord(value) {
        const word = String(value ?? '').normalize('NFC').trim();
        if (!word || word.length > 80 || /\s/u.test(word)) return '';
        if (!/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’_-]*$/u.test(word)) return '';
        return word;
    }

    function parseJsonWords(value) {
        const source = Array.isArray(value)
            ? value
            : (Array.isArray(value?.words) ? value.words : (Array.isArray(value?.entries) ? value.entries : []));
        return source.map(item => typeof item === 'string' ? item : (item?.word ?? item?.haslo ?? item?.lemma ?? ''));
    }

    async function parseDictionaryFile(file) {
        if (!file) return [];
        if (file.size > MAX_IMPORT_FILE_SIZE) throw new Error('Pojedyncza paczka może mieć maksymalnie 100 MB. Podziel słownik na mniejsze pliki.');
        const extension = (file.name.split('.').pop() || '').toLocaleLowerCase('pl-PL');
        const text = await file.text();
        let rawWords = [];

        if (extension === 'json') {
            rawWords = parseJsonWords(JSON.parse(text));
        } else if (extension === 'dic') {
            const lines = text.split(/\r?\n/u);
            if (/^\s*\d+\s*$/u.test(lines[0] || '')) lines.shift();
            rawWords = lines.map(line => {
                const cleaned = line.trim().replace(/\s+#.*$/u, '');
                const slash = cleaned.indexOf('/');
                return slash >= 0 ? cleaned.slice(0, slash) : cleaned;
            });
        } else if (extension === 'csv') {
            rawWords = text.split(/\r?\n/u).map(line => {
                const value = line.split(/[;,\t]/u)[0] || '';
                return value.replace(/^\s*["']|["']\s*$/gu, '');
            });
        } else {
            rawWords = text.split(/[\s,;]+/u);
        }

        const unique = new Map();
        let invalidCount = 0;
        rawWords.forEach(value => {
            const word = normalizeImportedWord(value);
            if (!word) {
                if (String(value ?? '').trim()) invalidCount++;
                return;
            }
            const key = normalizeDictionaryKey(word);
            if (['word', 'words', 'słowo', 'słowa', 'hasło', 'hasła', 'lemma'].includes(key)) return;
            if (!unique.has(key)) unique.set(key, word);
        });
        if (unique.size > MAX_IMPORT_WORDS_PER_FILE) {
            throw new Error(`Paczka zawiera ponad ${MAX_IMPORT_WORDS_PER_FILE.toLocaleString('pl-PL')} unikalnych haseł. Podziel ją na mniejsze pliki.`);
        }
        return { words: [...unique.values()], invalidCount };
    }

    async function saveImportBatch(records, job) {
        const dbHandle = await openDatabase();
        const transaction = dbHandle.transaction([WORD_STORE, SIGNATURE_STORE, META_STORE], 'readwrite');
        const wordStore = transaction.objectStore(WORD_STORE);
        const signatureStore = transaction.objectStore(SIGNATURE_STORE);
        records.forEach(record => {
            wordStore.put(record.word);
            signatureStore.put(record.signature);
        });
        transaction.objectStore(META_STORE).put(job);
        await transactionDone(transaction);
    }

    async function saveBackupBatch(records) {
        const dbHandle = await openDatabase();
        const transaction = dbHandle.transaction([WORD_STORE, SIGNATURE_STORE], 'readwrite');
        const wordStore = transaction.objectStore(WORD_STORE);
        const signatureStore = transaction.objectStore(SIGNATURE_STORE);
        records.forEach(record => {
            wordStore.put(record.word);
            signatureStore.put(record.signature);
        });
        await transactionDone(transaction);
    }

    function updateImportProgress(job) {
        if (!job || !elements.importProgress) return;
        elements.importProgress.max = Math.max(1, job.words.length);
        elements.importProgress.value = Math.min(job.words.length, job.index || 0);
        elements.importProgressText.textContent = `${(job.index || 0).toLocaleString('pl-PL')} / ${job.words.length.toLocaleString('pl-PL')}`;
    }

    async function runImportJob() {
        const token = ++importLoopToken;
        importPaused = false;
        if (elements.importPause) {
            elements.importPause.disabled = false;
            elements.importPause.textContent = 'Pauza importu';
        }
        if (elements.importSelect) elements.importSelect.disabled = true;

        let job = await getMeta(IMPORT_JOB_KEY);
        if (!job || !Array.isArray(job.words)) {
            importPaused = true;
            if (elements.importPause) elements.importPause.disabled = true;
            if (elements.importSelect) elements.importSelect.disabled = false;
            return;
        }
        job.status = 'running';
        await putMeta(job);

        try {
            while (job.index < job.words.length && !importPaused && token === importLoopToken) {
                const sourceBatch = job.words.slice(job.index, job.index + IMPORT_BATCH_SIZE);
                const records = [];
                const importedAt = new Date().toISOString();
                for (const word of sourceBatch) {
                    const key = normalizeDictionaryKey(word);
                    const localExists = typeof findLocalWord === 'function' && findLocalWord(db, word);
                    if (words.has(key) || localExists) {
                        job.skipped = (job.skipped || 0) + 1;
                        continue;
                    }
                    records.push(createImportRecords(word, job.fileName, importedAt));
                }
                job.index += sourceBatch.length;
                job.added = (job.added || 0) + records.length;
                job.status = 'running';
                await saveImportBatch(records, job);
                records.forEach(record => words.set(record.word.key, asBulkEntry(record.word)));
                updateImportProgress(job);
                setStatus(
                    `Paczka „${job.fileName}”: ${job.index.toLocaleString('pl-PL')}/${job.words.length.toLocaleString('pl-PL')} • dodano ${job.added.toLocaleString('pl-PL')} • duplikaty ${job.skipped.toLocaleString('pl-PL')}`
                );
                if (job.index % (IMPORT_BATCH_SIZE * 5) === 0 || job.index >= job.words.length) {
                    await refreshStats();
                    refreshMainInterface();
                }
                await new Promise(resolve => setTimeout(resolve, 0));
            }

            if (job.index >= job.words.length) {
                await deleteMeta(IMPORT_JOB_KEY);
                importPaused = true;
                if (elements.importPause) {
                    elements.importPause.disabled = true;
                    elements.importPause.textContent = 'Pauza importu';
                }
                if (elements.importSelect) elements.importSelect.disabled = false;
                setStatus(
                    `Import paczki zakończony. Dodano ${job.added.toLocaleString('pl-PL')} haseł, pominięto ${job.skipped.toLocaleString('pl-PL')} duplikatów. Możesz wczytać następną paczkę.`,
                    'success'
                );
                await refreshStats();
                refreshMainInterface();
                return;
            }

            job.status = 'paused';
            await putMeta(job);
            if (elements.importPause) {
                elements.importPause.disabled = false;
                elements.importPause.textContent = 'Wznów import';
            }
            if (elements.importSelect) elements.importSelect.disabled = true;
            setStatus(`Import zatrzymany na ${job.index.toLocaleString('pl-PL')}/${job.words.length.toLocaleString('pl-PL')}. Punkt wznowienia został zapisany.`);
        } catch (error) {
            if (token !== importLoopToken) return;
            importPaused = true;
            job.status = 'paused';
            await putMeta(job).catch(() => {});
            if (elements.importPause) {
                elements.importPause.disabled = false;
                elements.importPause.textContent = 'Wznów import';
            }
            console.error('Błąd importu dużego słownika:', error);
            setStatus(`Import zatrzymano: ${error.message}. Możesz spróbować wznowić.`, 'warning');
        }
    }

    async function beginImport(file) {
        if (!file) return;
        const existingJob = await getMeta(IMPORT_JOB_KEY);
        if (existingJob && existingJob.index < existingJob.words.length) {
            setStatus('Najpierw dokończ albo wznów poprzednią paczkę. Jej punkt wznowienia jest zapisany.', 'warning');
            return;
        }
        elements.importSelect.disabled = true;
        setStatus(`Czytam paczkę „${file.name}”…`);
        try {
            const parsed = await parseDictionaryFile(file);
            if (parsed.words.length === 0) throw new Error('Nie znaleziono poprawnych haseł. Użyj TXT, CSV, JSON lub Hunspell DIC.');
            const job = {
                key: IMPORT_JOB_KEY,
                version: 1,
                fileName: file.name,
                words: parsed.words,
                index: 0,
                added: 0,
                skipped: 0,
                invalid: parsed.invalidCount,
                status: 'running',
                createdAt: new Date().toISOString(),
            };
            await putMeta(job);
            updateImportProgress(job);
            setStatus(`Rozpoczynam indeksowanie ${parsed.words.length.toLocaleString('pl-PL')} haseł z paczki. Niepoprawne wpisy: ${parsed.invalidCount.toLocaleString('pl-PL')}.`);
            await runImportJob();
        } catch (error) {
            console.error('Nie udało się rozpocząć importu:', error);
            setStatus(`Nie udało się wczytać paczki: ${error.message}`, 'warning');
            elements.importSelect.disabled = false;
        }
    }

    async function toggleImportPause() {
        if (!importPaused) {
            importPaused = true;
            elements.importPause.disabled = true;
            elements.importPause.textContent = 'Zatrzymywanie…';
            return;
        }
        const job = await getMeta(IMPORT_JOB_KEY);
        if (!job) {
            elements.importPause.disabled = true;
            elements.importSelect.disabled = false;
            return;
        }
        runImportJob();
    }

    function signatureToTemplate(record) {
        const bits = unpackBits(record.packedBits);
        const entry = words.get(record.key);
        if (!entry) return null;
        return {
            entry,
            fingerprint: record.fingerprint,
            map: {
                bits,
                dilatedBits: dilateBinaryBits(bits),
                count: record.count,
                features: record.features instanceof Uint16Array
                    ? record.features
                    : new Uint16Array(record.features),
                aspect: record.aspect,
            },
        };
    }

    async function collectSignatureCandidates(map) {
        if (!database || words.size === 0) return [];
        const exactTransaction = database.transaction(SIGNATURE_STORE, 'readonly');
        const exactStore = exactTransaction.objectStore(SIGNATURE_STORE);
        const exactMatches = await requestAsPromise(
            exactStore.index('exactHash').getAll(binaryExactHash(map), 32)
        );
        if (exactMatches.length > 0) return exactMatches;

        const keys = binaryLshKeys(map);
        const transaction = database.transaction(SIGNATURE_STORE, 'readonly');
        const store = transaction.objectStore(SIGNATURE_STORE);
        const requests = keys.map((key, index) => requestAsPromise(store.index(`l${index}`).getAll(key, 520)));
        const groups = await Promise.all(requests);
        const unique = new Map();
        groups.flat().forEach(record => unique.set(record.key, record));

        if (unique.size < 48) {
            const bucket = Math.round(map.count / 18);
            const fallbackTransaction = database.transaction(SIGNATURE_STORE, 'readonly');
            const fallbackStore = fallbackTransaction.objectStore(SIGNATURE_STORE);
            const range = IDBKeyRange.bound(Math.max(0, bucket - 1), bucket + 1);
            const fallback = await requestAsPromise(fallbackStore.index('inkBucket').getAll(range, 900));
            fallback.forEach(record => unique.set(record.key, record));
        }
        return [...unique.values()];
    }

    async function matchBinaryMap(map) {
        await ready();
        const records = await collectSignatureCandidates(map);
        const templates = records.map(signatureToTemplate).filter(Boolean);
        return matchBinaryGlyph(map, templates);
    }

    function canvasToBlob(canvas) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Nie udało się utworzyć PNG.')), 'image/png');
        });
    }

    async function getAllKeys(storeName) {
        const dbHandle = await openDatabase();
        const transaction = dbHandle.transaction(storeName, 'readonly');
        return requestAsPromise(transaction.objectStore(storeName).getAllKeys());
    }

    async function savePngBatch(records, job) {
        const dbHandle = await openDatabase();
        const transaction = dbHandle.transaction([PNG_STORE, META_STORE], 'readwrite');
        const store = transaction.objectStore(PNG_STORE);
        records.forEach(record => store.put(record));
        transaction.objectStore(META_STORE).put(job);
        await transactionDone(transaction);
    }

    async function runPngJob() {
        const token = ++pngLoopToken;
        pngPaused = false;
        elements.pngStart.disabled = true;
        elements.pngPause.disabled = false;
        elements.pngPause.textContent = 'Pauza PNG';

        try {
            const [allWordKeys, cachedKeys] = await Promise.all([getAllKeys(WORD_STORE), getAllKeys(PNG_STORE)]);
            const cached = new Set(cachedKeys);
            const remaining = allWordKeys.filter(key => !cached.has(key));
            const job = {
                key: PNG_JOB_KEY,
                status: 'running',
                total: allWordKeys.length,
                cachedAtStart: cached.size,
                generatedThisRun: 0,
                updatedAt: new Date().toISOString(),
            };
            await putMeta(job);

            if (remaining.length === 0) {
                pngPaused = true;
                elements.pngStart.disabled = words.size === 0;
                elements.pngPause.disabled = true;
                await deleteMeta(PNG_JOB_KEY);
                setStatus('Pełny cache PNG jest już kompletny.', 'success');
                await refreshStats();
                return;
            }

            for (let offset = 0; offset < remaining.length && !pngPaused && token === pngLoopToken; offset += PNG_BATCH_SIZE) {
                const keys = remaining.slice(offset, offset + PNG_BATCH_SIZE);
                const records = [];
                for (const key of keys) {
                    const entry = words.get(key);
                    if (!entry) continue;
                    const canvas = createExportCanvas(getEntryGlyph(entry), 520);
                    const blob = await canvasToBlob(canvas);
                    records.push({
                        key,
                        word: entry.word,
                        blob,
                        width: 520,
                        height: 520,
                        createdAt: new Date().toISOString(),
                    });
                }
                job.generatedThisRun += records.length;
                job.updatedAt = new Date().toISOString();
                await savePngBatch(records, job);
                const totalCached = cached.size + job.generatedThisRun;
                elements.pngProgress.max = Math.max(1, allWordKeys.length);
                elements.pngProgress.value = totalCached;
                elements.pngProgressText.textContent = `${totalCached.toLocaleString('pl-PL')} / ${allWordKeys.length.toLocaleString('pl-PL')}`;
                setStatus(`Tworzenie pełnego cache PNG: ${totalCached.toLocaleString('pl-PL')}/${allWordKeys.length.toLocaleString('pl-PL')}. Możesz bezpiecznie zatrzymać zadanie.`);
                if (job.generatedThisRun % (PNG_BATCH_SIZE * 10) === 0) await refreshStorageEstimate();
                await new Promise(resolve => setTimeout(resolve, 0));
            }

            if (!pngPaused && token === pngLoopToken) {
                await deleteMeta(PNG_JOB_KEY);
                pngPaused = true;
                elements.pngPause.disabled = true;
                elements.pngStart.disabled = words.size === 0;
                setStatus('Pełny cache PNG został wygenerowany dla wszystkich zaimportowanych haseł.', 'success');
            } else {
                job.status = 'paused';
                await putMeta(job);
                elements.pngPause.textContent = 'Wznów PNG';
                elements.pngPause.disabled = false;
                elements.pngStart.disabled = true;
                setStatus('Generowanie PNG zatrzymane. Istniejące obrazy zachowano; wznowienie uzupełni tylko brakujące pliki.');
            }
            await refreshStats();
        } catch (error) {
            pngPaused = true;
            elements.pngStart.disabled = words.size === 0;
            elements.pngPause.textContent = 'Wznów PNG';
            console.error('Błąd cache PNG:', error);
            setStatus(`Generowanie PNG zatrzymano: ${error.message}`, 'warning');
            await refreshStats();
        }
    }

    function togglePngPause() {
        if (!pngPaused) {
            pngPaused = true;
            elements.pngPause.disabled = true;
            elements.pngPause.textContent = 'Zatrzymywanie…';
            return;
        }
        runPngJob();
    }

    async function requestPersistentStorage() {
        if (!navigator.storage?.persist) {
            setStatus('Ta przeglądarka nie udostępnia ręcznego żądania trwałej pamięci. Zainstalowana PWA nadal korzysta z IndexedDB.', 'warning');
            return;
        }
        try {
            const granted = await navigator.storage.persist();
            setStatus(
                granted
                    ? 'Przeglądarka przyznała aplikacji trwałą pamięć.'
                    : 'Przeglądarka nie przyznała trwałej pamięci. Nie czyść danych witryny i regularnie eksportuj ważne paczki.',
                granted ? 'success' : 'warning'
            );
            await refreshStorageEstimate();
        } catch (error) {
            setStatus(`Nie udało się zmienić trybu pamięci: ${error.message}`, 'warning');
        }
    }

    async function getRecordsByKeys(storeName, keys) {
        const dbHandle = await openDatabase();
        const transaction = dbHandle.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        return Promise.all(keys.map(key => requestAsPromise(store.get(key))));
    }

    async function downloadCachedZipBatch() {
        elements.zip.disabled = true;
        try {
            const keys = await getAllKeys(PNG_STORE);
            if (keys.length === 0) throw new Error('Cache PNG jest pusty. Najpierw wygeneruj obrazy.');
            const cursorRecord = await getMeta(ZIP_CURSOR_KEY);
            let offset = Number(cursorRecord?.offset) || 0;
            if (offset >= keys.length) offset = 0;
            const selectedKeys = keys.slice(offset, offset + ZIP_BATCH_SIZE);
            const records = (await getRecordsByKeys(PNG_STORE, selectedKeys)).filter(Boolean);
            const files = [];
            const manifest = [];
            for (let index = 0; index < records.length; index++) {
                const record = records[index];
                elements.zip.textContent = `Pakowanie ${index + 1}/${records.length}`;
                const number = String(offset + index + 1).padStart(6, '0');
                const fileName = `${number}-${sanitizeFileName(record.word)}.png`;
                files.push({ name: fileName, data: new Uint8Array(await record.blob.arrayBuffer()) });
                manifest.push({ file: fileName, word: record.word, key: record.key });
            }
            files.push({
                name: 'slownik-paczka.json',
                data: new TextEncoder().encode(JSON.stringify({
                    format: 'GLYPH-OS-PNG-BATCH',
                    version: 1,
                    from: offset + 1,
                    to: offset + records.length,
                    totalCached: keys.length,
                    words: manifest,
                }, null, 2)),
            });
            const blob = createZipBlob(files);
            const part = Math.floor(offset / ZIP_BATCH_SIZE) + 1;
            triggerBlobDownload(blob, `glyph-os-png-${String(part).padStart(3, '0')}-${formatLocalDate()}.zip`);
            const nextOffset = offset + records.length >= keys.length ? 0 : offset + records.length;
            await putMeta({ key: ZIP_CURSOR_KEY, offset: nextOffset, updatedAt: new Date().toISOString() });
            setStatus(`Pobrano paczkę ZIP ${part}: ${records.length} obrazów. Następne kliknięcie rozpocznie od pozycji ${nextOffset + 1}.`, 'success');
        } catch (error) {
            console.error('Błąd eksportu cache PNG:', error);
            setStatus(`Nie udało się utworzyć paczki ZIP: ${error.message}`, 'warning');
        } finally {
            elements.zip.textContent = 'Pobierz następną paczkę ZIP';
            elements.zip.disabled = false;
            await refreshStats();
        }
    }

    function exportBackupRecords() {
        return [...words.values()].map(entry => ({
            word: entry.word,
            key: entry.key,
            variantSeed: entry.variantSeed,
            generatorVersion: entry.generatorVersion,
            importedAt: entry.timestamp || null,
            sourceName: entry.sourceName || '',
        }));
    }

    async function importBackupRecords(sourceRecords, onProgress = null) {
        await ready();
        if (!Array.isArray(sourceRecords)) throw new Error('Backup nie zawiera listy słownika masowego.');
        if (sourceRecords.length > MAX_BACKUP_WORDS) {
            throw new Error(`Backup przekracza limit ${MAX_BACKUP_WORDS.toLocaleString('pl-PL')} haseł masowych.`);
        }
        const activeJob = await getMeta(IMPORT_JOB_KEY);
        if (activeJob && Array.isArray(activeJob.words) && activeJob.index < activeJob.words.length) {
            throw new Error('Najpierw dokończ rozpoczęty import paczki słownika.');
        }

        const unique = new Map();
        let invalid = 0;
        sourceRecords.forEach(source => {
            const rawWord = typeof source === 'string' ? source : source?.word;
            const word = normalizeImportedWord(rawWord);
            if (!word) {
                invalid += 1;
                return;
            }
            const key = normalizeDictionaryKey(word);
            if (!unique.has(key)) unique.set(key, {
                word,
                key,
                variantSeed: typeof source === 'object' ? source.variantSeed : null,
                generatorVersion: typeof source === 'object' ? source.generatorVersion : null,
                importedAt: typeof source === 'object' ? source.importedAt : null,
                sourceName: typeof source === 'object' ? source.sourceName : '',
            });
        });

        let processed = 0;
        let added = 0;
        let skipped = 0;
        const records = [...unique.values()];
        if (elements.importSelect) elements.importSelect.disabled = true;
        try {
            for (let offset = 0; offset < records.length; offset += IMPORT_BATCH_SIZE) {
                const sourceBatch = records.slice(offset, offset + IMPORT_BATCH_SIZE);
                const importRecords = [];
                for (const source of sourceBatch) {
                    const localExists = typeof findLocalWord === 'function' && findLocalWord(db, source.word);
                    if (words.has(source.key) || localExists) {
                        skipped += 1;
                        continue;
                    }
                    importRecords.push(createImportRecords(
                        source.word,
                        source.sourceName || 'backup-json',
                        source.importedAt || new Date().toISOString(),
                        source,
                    ));
                }
                await saveBackupBatch(importRecords);
                importRecords.forEach(record => words.set(record.word.key, asBulkEntry(record.word)));
                processed += sourceBatch.length;
                added += importRecords.length;
                if (typeof onProgress === 'function') onProgress({
                    processed,
                    total: records.length,
                    added,
                    skipped,
                    invalid,
                });
                if (processed % (IMPORT_BATCH_SIZE * 5) === 0 || processed >= records.length) {
                    await refreshStats();
                    refreshMainInterface();
                }
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        } finally {
            if (elements.importSelect) elements.importSelect.disabled = false;
        }
        await refreshStats();
        refreshMainInterface();
        return { processed, added, skipped, invalid, total: records.length };
    }

    function downloadCombinedWordList() {
        const combined = new Map();
        if (typeof db !== 'undefined' && Array.isArray(db.words)) {
            db.words.forEach(entry => {
                const key = normalizeDictionaryKey(entry.word);
                if (key) combined.set(key, entry.word);
            });
        }
        words.forEach(entry => {
            if (!combined.has(entry.key)) combined.set(entry.key, entry.word);
        });
        if (combined.size === 0) {
            setStatus('Baza jest pusta — nie ma listy słów do pobrania.', 'warning');
            return;
        }
        const wordList = [...combined.values()].sort((left, right) => left.localeCompare(right, 'pl-PL'));
        const blob = new Blob(['\ufeff', wordList.join('\n'), '\n'], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `glyph-os-lista-slow-${new Date().toISOString().slice(0, 10)}.txt`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        setStatus(`Pobrano listę ${combined.size.toLocaleString('pl-PL')} słów obecnych w bazie.`, 'success');
    }

    async function removeWord(value) {
        await ready();
        const key = normalizeDictionaryKey(value);
        if (!words.has(key)) return false;
        const transaction = database.transaction([WORD_STORE, SIGNATURE_STORE, PNG_STORE], 'readwrite');
        transaction.objectStore(WORD_STORE).delete(key);
        transaction.objectStore(SIGNATURE_STORE).delete(key);
        transaction.objectStore(PNG_STORE).delete(key);
        await transactionDone(transaction);
        words.delete(key);
        await refreshStats();
        refreshMainInterface();
        return true;
    }

    async function clearDatabase(skipConfirmation = false) {
        if (!skipConfirmation && !confirm('Usunąć wszystkie hasła słownika masowego, indeksy i cache PNG? Tej operacji nie można cofnąć.')) return false;
        importPaused = true;
        pngPaused = true;
        importLoopToken++;
        pngLoopToken++;
        if (database) database.close();
        database = null;
        await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(DATABASE_NAME);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error || new Error('Nie udało się usunąć dużej bazy.'));
            request.onblocked = () => reject(new Error('Zamknij inne karty aplikacji i spróbuj ponownie.'));
        });
        words.clear();
        initializePromise = openDatabase().then(loadWordsIntoMemory);
        await initializePromise;
        resetProgressUi();
        await refreshStats();
        refreshMainInterface();
        setStatus('Usunięto słownik masowy, jego indeksy i cache PNG.', 'success');
        return true;
    }

    function resetProgressUi() {
        if (elements.importProgress) {
            elements.importProgress.max = 1;
            elements.importProgress.value = 0;
            elements.importProgressText.textContent = '0 / 0';
        }
        if (elements.pngProgress) {
            elements.pngProgress.max = 1;
            elements.pngProgress.value = 0;
            elements.pngProgressText.textContent = '0 / 0';
        }
        if (elements.importPause) {
            elements.importPause.disabled = true;
            elements.importPause.textContent = 'Pauza importu';
        }
        if (elements.pngPause) {
            elements.pngPause.disabled = true;
            elements.pngPause.textContent = 'Pauza PNG';
        }
        if (elements.importSelect) elements.importSelect.disabled = false;
    }

    function bindElements() {
        elements.words = document.getElementById('bulkWordCount');
        elements.signatures = document.getElementById('bulkSignatureCount');
        elements.png = document.getElementById('bulkPngCount');
        elements.storage = document.getElementById('bulkStorage');
        elements.input = document.getElementById('bulkDictionaryFile');
        elements.importSelect = document.getElementById('bulkImportSelect');
        elements.importPause = document.getElementById('bulkImportPause');
        elements.importProgress = document.getElementById('bulkImportProgress');
        elements.importProgressText = document.getElementById('bulkImportProgressText');
        elements.pngStart = document.getElementById('bulkPngStart');
        elements.pngPause = document.getElementById('bulkPngPause');
        elements.pngProgress = document.getElementById('bulkPngProgress');
        elements.pngProgressText = document.getElementById('bulkPngProgressText');
        elements.persist = document.getElementById('bulkPersist');
        elements.zip = document.getElementById('bulkZip');
        elements.backup = document.getElementById('bulkBackup');
        elements.wordList = document.getElementById('bulkWordList');
        elements.clear = document.getElementById('bulkClear');
        elements.status = document.getElementById('bulkStatus');
    }

    function bindEvents() {
        elements.importSelect?.addEventListener('click', () => elements.input.click());
        elements.input?.addEventListener('change', event => {
            const file = event.target.files?.[0];
            if (file) beginImport(file);
            event.target.value = '';
        });
        elements.importPause?.addEventListener('click', toggleImportPause);
        elements.pngStart?.addEventListener('click', runPngJob);
        elements.pngPause?.addEventListener('click', togglePngPause);
        elements.persist?.addEventListener('click', requestPersistentStorage);
        elements.zip?.addEventListener('click', downloadCachedZipBatch);
        elements.backup?.addEventListener('click', async () => {
            if (typeof exportDatabase !== 'function') return;
            setStatus('Przygotowuję pełny backup ręcznych znaków i słownika masowego…');
            const result = await exportDatabase();
            if (result) {
                setStatus(
                    `Pobrano pełny backup ${result.total.toLocaleString('pl-PL')} haseł, w tym ${result.bulkWords.toLocaleString('pl-PL')} masowych.`,
                    'success'
                );
            }
        });
        elements.wordList?.addEventListener('click', downloadCombinedWordList);
        elements.clear?.addEventListener('click', () => clearDatabase(false));
    }

    async function initialize() {
        bindElements();
        bindEvents();
        if (!('indexedDB' in window)) {
            setStatus('Ta przeglądarka nie obsługuje IndexedDB. Słownik masowy jest niedostępny.', 'warning');
            return;
        }
        setStatus('Uruchamiam magazyn IndexedDB i wczytuję indeks słów…');
        try {
            await openDatabase();
            await loadWordsIntoMemory();
            const importJob = await getMeta(IMPORT_JOB_KEY);
            if (importJob && Array.isArray(importJob.words) && importJob.index < importJob.words.length) {
                importPaused = true;
                updateImportProgress(importJob);
                elements.importPause.disabled = false;
                elements.importPause.textContent = 'Wznów import';
                elements.importSelect.disabled = true;
                setStatus(`Znaleziono niedokończoną paczkę „${importJob.fileName}”: ${importJob.index.toLocaleString('pl-PL')}/${importJob.words.length.toLocaleString('pl-PL')}. Kliknij „Wznów import”.`);
            } else {
                setStatus(words.size > 0
                    ? `Słownik masowy gotowy: ${words.size.toLocaleString('pl-PL')} haseł. Możesz dołożyć następną paczkę.`
                    : 'Słownik masowy jest pusty. Wczytaj pierwszą paczkę TXT, CSV, JSON lub Hunspell DIC.');
            }
            const pngJob = await getMeta(PNG_JOB_KEY);
            if (pngJob) {
                pngPaused = true;
                elements.pngPause.disabled = words.size === 0;
                elements.pngPause.textContent = 'Wznów PNG';
            }
            await refreshStats();
            refreshMainInterface();
        } catch (error) {
            console.error('Inicjalizacja dużej bazy nie powiodła się:', error);
            setStatus(`Duża baza nie została uruchomiona: ${error.message}`, 'warning');
        }
    }

    function ready() {
        if (!initializePromise) initializePromise = initialize();
        return initializePromise;
    }

    window.GlyphBulk = {
        ready,
        count: () => words.size,
        totalUniqueCount: getTotalUniqueCount,
        findWord: getWord,
        search: searchWords,
        recent: recentWords,
        randomWord,
        matchBinaryMap,
        exportBackupRecords,
        importBackupRecords,
        downloadCombinedWordList,
        removeWord,
        clear: clearDatabase,
        refreshStats,
    };

    initializePromise = initialize();
}());
