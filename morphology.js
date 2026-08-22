(function (global) {
    'use strict';

    const MORPHOLOGY_VERSION = 1;
    const MAX_MODIFIER_CODE = 1023;

    const IRREGULAR_FAMILIES = new Map(Object.entries({
        jestem: 'być', jesteś: 'być', jest: 'być', jesteśmy: 'być', jesteście: 'być', są: 'być',
        byłem: 'być', byłam: 'być', był: 'być', była: 'być', było: 'być', byli: 'być', były: 'być',
        będę: 'być', będziesz: 'być', będzie: 'być', będziemy: 'być', będziecie: 'być', będą: 'być',
        mam: 'mieć', masz: 'mieć', ma: 'mieć', mamy: 'mieć', macie: 'mieć', mają: 'mieć',
        miałem: 'mieć', miałam: 'mieć', miał: 'mieć', miała: 'mieć', mieli: 'mieć', miały: 'mieć',
        idę: 'iść', idziesz: 'iść', idzie: 'iść', idziemy: 'iść', idziecie: 'iść', idą: 'iść',
        poszedłem: 'iść', poszłam: 'iść', poszedł: 'iść', poszła: 'iść', poszli: 'iść',
        ludzie: 'człowiek', ludzi: 'człowiek', ludźmi: 'człowiek', człowieka: 'człowiek',
        człowiekowi: 'człowiek', człowiekiem: 'człowiek', człowieku: 'człowiek',
    }));

    function normalize(value) {
        return String(value ?? '')
            .normalize('NFC')
            .trim()
            .toLocaleLowerCase('pl-PL');
    }

    function stableHash(value) {
        const text = normalize(value);
        let hash = 2166136261;
        for (let index = 0; index < text.length; index++) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    function normalizeWordRecord(source) {
        const raw = typeof source === 'string'
            ? source
            : (source?.word ?? source?.haslo ?? source?.hasło ?? source?.surface ?? source?.lemma ?? '');
        const word = String(raw ?? '').normalize('NFC').trim();
        if (!word) return null;
        return {
            ...(typeof source === 'object' && source ? source : {}),
            word,
            key: normalize(word),
        };
    }

    function explicitFamilyKey(entry) {
        if (!entry || entry.morphologySource === 'heuristic') return '';
        const explicit = entry.familyLocked
            ? (entry.familyKey || entry.lemma || entry.baseWord || entry.base)
            : (entry.explicitLemma || entry.baseWord || entry.base || (
                entry.morphologyVersion ? '' : entry.lemma
            ));
        return normalize(explicit);
    }

    function addCandidate(target, word, suffix, replacement, relation, score) {
        if (!word.endsWith(suffix) || word.length <= suffix.length) return;
        const candidate = `${word.slice(0, -suffix.length)}${replacement}`;
        // Krótkie polskie słowa bardzo łatwo przypadkowo pokrywają się z
        // końcówką dłuższego hasła (np. „dom” → „da”). Automatyczne łączenie
        // stosujemy dopiero od trzech znaków; wyjątki obsługuje jawna mapa.
        if (candidate.length < 3 || candidate === word) return;
        const previous = target.get(candidate);
        if (!previous || score > previous.score) {
            target.set(candidate, { key: candidate, relation, score });
        }
    }

    /**
     * Kandydaci są celowo zachowawczy i muszą istnieć w bieżącej paczce albo
     * już zapisanej bazie. Silnik nie zgaduje nieistniejących lematów.
     */
    function candidateFamilies(value) {
        const word = normalize(value);
        const candidates = new Map();
        const irregular = IRREGULAR_FAMILIES.get(word);
        if (irregular) candidates.set(irregular, { key: irregular, relation: 'irregular', score: 200 });

        // Zdrobnienia rodzaju męskiego: domek, domku, domkiem, domki…
        [
            ['eczek', '', 150], ['iczek', '', 150], ['yczek', '', 150], ['uszek', '', 145],
            ['aczek', '', 145], ['ek', '', 140], ['ik', '', 136], ['yk', '', 136],
        ].forEach(([suffix, replacement, score]) => {
            addCandidate(candidates, word, suffix, replacement, 'diminutive', score);
        });
        [
            ['kami', 'ek'], ['kach', 'ek'], ['kiem', 'ek'], ['kowi', 'ek'],
            ['ków', 'ek'], ['kom', 'ek'], ['ku', 'ek'], ['ki', 'ek'], ['ka', 'ek'],
        ].forEach(([suffix, replacement], index) => {
            addCandidate(candidates, word, suffix, replacement, 'diminutive-inflection', 148 - index);
        });

        // Zdrobnienia rodzaju żeńskiego: chatka, chatki, chatkę, chatką…
        [
            ['eczkami', 'a'], ['eczkach', 'a'], ['eczki', 'a'], ['eczkę', 'a'], ['eczką', 'a'], ['eczka', 'a'],
            ['kami', 'a'], ['kach', 'a'], ['kom', 'a'], ['ki', 'a'], ['kę', 'a'], ['ką', 'a'], ['ce', 'a'], ['ka', 'a'],
        ].forEach(([suffix, replacement], index) => {
            addCandidate(candidates, word, suffix, replacement, 'diminutive', 132 - Math.min(index, 20));
        });

        // Najczęstsze końcówki przypadków rzeczowników. Najpierw sprawdzane są
        // formy z -a, a dopiero potem nagi rdzeń, co pomaga dla „kobietami”.
        [
            ['ami', 'a', 116], ['ach', 'a', 115], ['om', 'a', 108],
            ['ę', 'a', 122], ['ą', 'a', 122],
        ].forEach(([suffix, replacement, score]) => {
            addCandidate(candidates, word, suffix, replacement, 'inflection', score);
        });
        if (word.length >= 5) {
            [['ie', 'a', 104], ['y', 'a', 104], ['i', 'a', 102]].forEach(([suffix, replacement, score]) => {
                addCandidate(candidates, word, suffix, replacement, 'inflection', score);
            });
        }
        [
            ['owie', '', 112], ['owego', '', 108], ['owemu', '', 108], ['ami', '', 106],
            ['ach', '', 105], ['owi', '', 103], ['ów', '', 103], ['om', '', 101],
            ['em', '', 98], ['ie', '', 94], ['u', '', 92], ['a', '', 90],
            ['y', '', 86], ['i', '', 84],
        ].forEach(([suffix, replacement, score]) => {
            addCandidate(candidates, word, suffix, replacement, 'inflection', score);
        });

        // Podstawowe formy czasownikowe, ale wyłącznie wtedy, gdy bezokolicznik
        // rzeczywiście występuje w słowniku.
        [
            ['ujesz', 'ować', 118], ['ujemy', 'ować', 118], ['ujecie', 'ować', 118],
            ['ują', 'ować', 118], ['uję', 'ować', 118], ['ował', 'ować', 116],
            ['owała', 'ować', 116], ['owali', 'ować', 116],
            ['asz', 'ać', 104], ['amy', 'ać', 104], ['acie', 'ać', 104], ['ają', 'ać', 104], ['am', 'ać', 102],
            ['isz', 'ić', 102], ['imy', 'ić', 102], ['icie', 'ić', 102], ['ią', 'ić', 100],
        ].forEach(([suffix, replacement, score]) => {
            addCandidate(candidates, word, suffix, replacement, 'conjugation', score);
        });
        for (const [key, candidate] of candidates) {
            if (candidate.relation === 'conjugation' && key.length < 4) candidates.delete(key);
        }

        return [...candidates.values()].sort((left, right) => (
            right.score - left.score || left.key.length - right.key.length || left.key.localeCompare(right.key, 'pl')
        ));
    }

    function modifierCode(familyKey, wordKey) {
        if (!familyKey || familyKey === wordKey) return 0;
        return (stableHash(`${familyKey}\u0000${wordKey}`) % MAX_MODIFIER_CODE) + 1;
    }

    function migrateEntries(sourceEntries, options = {}) {
        const records = (Array.isArray(sourceEntries) ? sourceEntries : [])
            .map(normalizeWordRecord)
            .filter(Boolean);
        const knownRecords = (Array.isArray(options.knownEntries) ? options.knownEntries : [])
            .map(normalizeWordRecord)
            .filter(Boolean);
        const allByKey = new Map();
        const rankByKey = new Map();
        knownRecords.forEach(entry => allByKey.set(entry.key, entry));
        records.forEach((entry, index) => {
            allByKey.set(entry.key, entry);
            if (!rankByKey.has(entry.key)) rankByKey.set(entry.key, index);
        });
        const availableKeys = new Set(allByKey.keys());
        const familyCache = new Map();
        const relationCache = new Map();

        function resolveFamily(entry, trail = new Set()) {
            if (!entry) return '';
            if (familyCache.has(entry.key)) return familyCache.get(entry.key);
            const explicit = explicitFamilyKey(entry);
            if (explicit) {
                familyCache.set(entry.key, explicit);
                relationCache.set(entry.key, 'explicit');
                return explicit;
            }
            if (trail.has(entry.key)) return entry.key;
            const nextTrail = new Set(trail);
            nextTrail.add(entry.key);

            const candidate = candidateFamilies(entry.key).find(item => {
                const sourceRank = rankByKey.get(entry.key);
                const targetRank = rankByKey.get(item.key);
                const implausiblyRareTarget = records.length >= 10000 &&
                    Number.isInteger(sourceRank) && Number.isInteger(targetRank) &&
                    targetRank > sourceRank * 12 + 500;
                return availableKeys.has(item.key) &&
                !implausiblyRareTarget &&
                !(IRREGULAR_FAMILIES.has(item.key) && !IRREGULAR_FAMILIES.has(entry.key)) && (
                    item.relation === 'irregular' ||
                    item.key.length < entry.key.length ||
                    (item.key.length === entry.key.length && item.score >= 100)
                );
            });
            if (!candidate) {
                familyCache.set(entry.key, entry.key);
                relationCache.set(entry.key, 'base');
                return entry.key;
            }
            const target = allByKey.get(candidate.key);
            const knownTargetFamily = target?.morphologySource === 'explicit' || target?.familyLocked
                ? normalize(target.familyKey || target.lemma)
                : '';
            const family = knownTargetFamily || resolveFamily(target, nextTrail) || candidate.key;
            familyCache.set(entry.key, family);
            relationCache.set(entry.key, candidate.relation);
            return family;
        }

        records.forEach(entry => resolveFamily(entry));

        const familyMembers = new Map();
        records.forEach(entry => {
            const familyKey = familyCache.get(entry.key) || entry.key;
            if (!familyMembers.has(familyKey)) familyMembers.set(familyKey, []);
            familyMembers.get(familyKey).push(entry);
        });

        const knownByFamily = new Map();
        knownRecords.forEach(entry => {
            const familyKey = normalize(entry.familyKey || entry.lemma || entry.key);
            if (!knownByFamily.has(familyKey)) knownByFamily.set(familyKey, entry);
        });

        let grouped = 0;
        let legacyAliases = 0;
        const migrated = [];
        familyMembers.forEach((members, familyKey) => {
            const representative = knownByFamily.get(familyKey) ||
                members.find(entry => entry.key === familyKey) ||
                [...members].sort((left, right) => (
                    left.key.length - right.key.length || left.key.localeCompare(right.key, 'pl')
                ))[0];
            const familySeed = Number.isFinite(Number(representative?.familyVariantSeed))
                ? Number(representative.familyVariantSeed) >>> 0
                : (Number.isFinite(Number(representative?.variantSeed))
                    ? Number(representative.variantSeed) >>> 0
                    : stableHash(`glyph-family:${familyKey}`));
            const baseGlyphData = representative?.baseGlyphData || representative?.glyphData || null;

            // Kod formy musi być unikalny w obrębie rodziny, bo inaczej dwa
            // różne słowa dawałyby identyczny obraz. Punkt startowy pochodzi z
            // hasha, a ewentualną kolizję rozwiązujemy deterministycznie.
            const usedModifierCodes = new Set();
            const modifierByKey = new Map();
            if (members.some(entry => entry.key === familyKey)) {
                usedModifierCodes.add(0);
                modifierByKey.set(familyKey, 0);
            }
            [...members]
                .sort((left, right) => left.key.localeCompare(right.key, 'pl'))
                .forEach(entry => {
                    if (modifierByKey.has(entry.key)) return;
                    let code = modifierCode(familyKey, entry.key);
                    while (usedModifierCodes.has(code)) {
                        code = code >= MAX_MODIFIER_CODE ? 1 : code + 1;
                    }
                    usedModifierCodes.add(code);
                    modifierByKey.set(entry.key, code);
                });

            members.forEach(entry => {
                const relation = relationCache.get(entry.key) || (entry.key === familyKey ? 'base' : 'related');
                const code = modifierByKey.get(entry.key) ?? modifierCode(familyKey, entry.key);
                const wasLegacy = !Number.isInteger(entry.morphologyVersion) || entry.morphologyVersion < MORPHOLOGY_VERSION;
                const oldGlyphWord = normalize(entry.glyphWord || entry.key);
                const oldSeed = Number.isFinite(Number(entry.variantSeed)) ? Number(entry.variantSeed) >>> 0 : null;
                const familyChanged = oldGlyphWord !== familyKey || Number(entry.modifierCode || 0) !== code;
                const output = {
                    ...entry,
                    key: entry.key,
                    familyKey,
                    lemma: familyKey,
                    glyphWord: familyKey,
                    familyVariantSeed: familySeed,
                    variantSeed: familySeed,
                    modifierCode: code,
                    morphologyRelation: relation,
                    morphologySource: explicitFamilyKey(entry) ? 'explicit' : 'heuristic',
                    morphologyVersion: MORPHOLOGY_VERSION,
                };
                if (baseGlyphData) output.glyphData = baseGlyphData;
                if ((wasLegacy || familyChanged) && options.preserveLegacy !== false && familyChanged) {
                    output.legacyGlyphWord = entry.legacyGlyphWord || oldGlyphWord;
                    output.legacyVariantSeed = entry.legacyVariantSeed ?? oldSeed;
                    output.legacyGeneratorVersion = entry.legacyGeneratorVersion ?? entry.generatorVersion ?? 1;
                    if (Array.isArray(entry.glyphData) && entry.glyphData.length > 0) {
                        output.legacyGlyphData = entry.legacyGlyphData || entry.glyphData;
                    }
                    legacyAliases++;
                }
                if (familyKey !== entry.key) grouped++;
                migrated.push(output);
            });
        });

        const migratedByKey = new Map(migrated.map(entry => [entry.key, entry]));
        const orderedEntries = records.map(entry => migratedByKey.get(entry.key)).filter(Boolean);
        return {
            entries: orderedEntries,
            statistics: {
                words: orderedEntries.length,
                families: new Set(orderedEntries.map(entry => entry.familyKey)).size,
                grouped,
                legacyAliases,
            },
        };
    }

    global.GlyphMorphology = Object.freeze({
        version: MORPHOLOGY_VERSION,
        normalize,
        stableHash,
        candidateFamilies,
        modifierCode,
        migrateEntries,
    });
}(globalThis));
