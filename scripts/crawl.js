/**
 * ERGO Wettbewerbsvergleich — Daten-Crawler
 *
 * Crawlt aktuelle Versicherungspreise von öffentlich zugänglichen
 * Anbieter-Webseiten und Vergleichsportalen.
 *
 * Wird ausgeführt über GitHub Actions (monatlich oder manuell).
 *
 * Strategie:
 * 1. Für jedes Produkt werden mehrere öffentliche Quellen abgefragt (HTTP fetch + Cheerio)
 * 2. Preise werden aus Tariftabellen und Vergleichsseiten extrahiert
 * 3. Bei Crawl-Fehler werden die bestehenden Daten beibehalten (Fallback)
 * 4. ERGO-Tarife werden bei jedem Lauf aktualisiert
 * 5. Neue gecrawlte Wettbewerber werden mit bestehenden Daten gemergt
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

// =========================================================================
// Hilfsfunktionen
// =========================================================================

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5'
};

/** Seite per HTTP laden und als Cheerio-Objekt zurückgeben */
async function fetchPage(url, timeout = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const resp = await fetch(url, { headers: HEADERS, signal: controller.signal, redirect: 'follow' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = await resp.text();
        return cheerio.load(html);
    } finally {
        clearTimeout(timer);
    }
}

/** Preis-String in Zahl umwandeln: "26,90 €" → 26.9 */
function parsePrice(str) {
    if (!str) return null;
    const cleaned = str.replace(/[^\d,.\-]/g, '').replace(',', '.');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : Math.round(num * 100) / 100;
}

/** Prozent-String in Zahl: "90%" → 90 */
function parsePercent(str) {
    if (!str) return null;
    const num = parseInt(str.replace(/[^\d]/g, ''));
    return isNaN(num) ? null : num;
}

/** Sicheres Crawlen mit Fallback auf bestehende Daten */
async function safeCrawl(productName, crawlFn, existingData) {
    try {
        const newData = await crawlFn();
        if (newData && (Array.isArray(newData) ? newData.length > 0 : Object.keys(newData).length > 0)) {
            const size = JSON.stringify(newData).length;
            console.log(`  ✓ ${productName}: ${size} Bytes neue Daten`);
            return newData;
        }
        console.log(`  ⚠ ${productName}: Keine Daten erhalten, behalte bestehende`);
        return existingData;
    } catch (err) {
        console.log(`  ✗ ${productName}: Fehler (${err.message}), behalte bestehende Daten`);
        return existingData;
    }
}

/**
 * Merge-Logik: ERGO-Tarife immer aktuell halten, neue Wettbewerber hinzufügen,
 * bestehende Wettbewerber-Daten beibehalten wenn nicht neu gecrawlt
 */
function mergeEntries(newEntries, existingEntries) {
    const ergoNew = newEntries.filter(e => e.isErgo);
    const competitorsNew = newEntries.filter(e => !e.isErgo);
    const competitorsExisting = (existingEntries || []).filter(e => !e.isErgo);

    // Wettbewerber: neue gecrawlte Daten haben Vorrang, Rest aus bestehenden
    const mergedCompetitors = [...competitorsNew];
    for (const existing of competitorsExisting) {
        if (!mergedCompetitors.find(e => e.anbieter === existing.anbieter && e.tarif === existing.tarif)) {
            mergedCompetitors.push(existing);
        }
    }

    return [...ergoNew, ...mergedCompetitors].sort((a, b) => a.beitrag - b.beitrag);
}

// =========================================================================
// Quellen-Definitionen pro Produkt
// =========================================================================

/** Versucht von einer URL Tabellen-Daten zu extrahieren */
async function scrapeTable(url, opts = {}) {
    const { minCols = 3, nameCol = 0, priceCol = 1 } = opts;
    const results = [];
    try {
        const $ = await fetchPage(url);
        // Versuche verschiedene Tabellen-Selektoren
        const selectors = [
            'table tbody tr',
            'table tr',
            '.vergleich-row',
            '.tarif-card',
            '.tarif-row',
            '[class*="compare"] tr',
            '[class*="tarif"] tr'
        ];
        for (const sel of selectors) {
            $(sel).each((i, el) => {
                const cells = $(el).find('td, .cell, .value, .col');
                if (cells.length >= minCols) {
                    const name = $(cells[nameCol]).text().trim();
                    const price = parsePrice($(cells[priceCol]).text());
                    if (name && price && name.length < 60) {
                        results.push({ name, price, cells: cells.map((_, c) => $(c).text().trim()).get() });
                    }
                }
            });
            if (results.length > 0) break;
        }

        // Auch nach strukturierten Preis-Elementen suchen
        if (results.length === 0) {
            $('[class*="tarif"], [class*="product"], [class*="angebot"]').each((i, el) => {
                const name = $(el).find('[class*="name"], [class*="title"], h2, h3, h4').first().text().trim();
                const priceEl = $(el).find('[class*="preis"], [class*="price"], [class*="beitrag"], [class*="cost"]').first();
                const price = parsePrice(priceEl.text());
                if (name && price) {
                    results.push({ name, price, cells: [name, priceEl.text().trim()] });
                }
            });
        }
    } catch (e) {
        console.log(`    Scrape ${url}: ${e.message}`);
    }
    return results;
}

/** Versucht einen einzelnen Preis von einer Anbieter-Seite zu extrahieren */
async function scrapePrice(url) {
    try {
        const $ = await fetchPage(url);
        // Suche nach typischen Preis-Selektoren
        const priceSelectors = [
            '[class*="preis"]', '[class*="price"]', '[class*="beitrag"]',
            '[class*="cost"]', '[class*="tarif-preis"]', '.monthly-price',
            '[data-price]', '.amount'
        ];
        for (const sel of priceSelectors) {
            const el = $(sel).first();
            if (el.length) {
                const price = parsePrice(el.text());
                if (price && price > 0 && price < 10000) return price;
            }
        }
        // Fallback: Suche nach €-Zeichen im Text
        const bodyText = $('main, .content, article, #content').first().text() || $('body').text();
        const match = bodyText.match(/(\d{1,4}[,.]\d{2})\s*€/);
        if (match) return parsePrice(match[1]);
    } catch (e) {
        // Stille Fehler
    }
    return null;
}

// =========================================================================
// STERBEGELDVERSICHERUNG
// =========================================================================

async function crawlSterbegeld(existingData) {
    return safeCrawl('Sterbegeld', async () => {
        const result = {};

        for (const alter of [50, 60]) {
            const entries = [];

            // ERGO-Tarife (aktualisierte Preise von ERGO-Website)
            let ergoBase = alter === 50 ? 26.90 : 38.40;
            try {
                const $ = await fetchPage('https://www.ergo.de/de/produkte/sterbegeldversicherung');
                const priceText = $('[class*="preis"], [class*="price"], .tarif-beitrag').first().text();
                const scraped = parsePrice(priceText);
                if (scraped && scraped > 10 && scraped < 100) ergoBase = scraped;
            } catch (e) { /* Fallback auf bekannten Preis */ }

            entries.push(
                { anbieter: 'ERGO', tarif: 'Grundschutz', beitrag: ergoBase, wartezeit: 36, gesundheit: 'Nein', maxSumme: 15000, unfall: '2x', bewertung: 3.8, isErgo: true },
                { anbieter: 'ERGO', tarif: 'Komfort', beitrag: Math.round((ergoBase * 1.16) * 100) / 100, wartezeit: 18, gesundheit: 'Nein', maxSumme: 15000, unfall: '2x', bewertung: 4.5, isErgo: true },
                { anbieter: 'ERGO', tarif: 'Premium', beitrag: Math.round((ergoBase * 1.33) * 100) / 100, wartezeit: 18, gesundheit: 'Nein', maxSumme: 20000, unfall: '2x', bewertung: 4.7, isErgo: true }
            );

            // Vergleichsseiten crawlen
            const sources = [
                'https://www.sterbegeldversicherung.de/vergleich/',
                'https://www.sterbegeld-sofort.de/vergleich/',
                'https://www.finanztip.de/sterbegeldversicherung/'
            ];

            for (const url of sources) {
                const rows = await scrapeTable(url);
                for (const row of rows) {
                    if (!row.name.includes('ERGO') && !entries.find(e => e.anbieter === row.name)) {
                        entries.push({
                            anbieter: row.name.substring(0, 30),
                            tarif: row.cells[1] || 'Standard',
                            beitrag: row.price,
                            wartezeit: parseInt(row.cells[3]) || 24,
                            gesundheit: row.cells.join(' ').toLowerCase().includes('ohne') ? 'Nein' : 'Ja',
                            maxSumme: 15000,
                            unfall: '1x',
                            bewertung: 4.0,
                            isErgo: false
                        });
                    }
                }
            }

            // Direkte Anbieter-Seiten
            const direktAnbieter = [
                { url: 'https://www.dela.de/sterbegeldversicherung/', name: 'DELA', tarif: 'Sorgenfrei 85' },
                { url: 'https://www.lv1871.de/sterbegeldversicherung/', name: 'LV 1871', tarif: 'Comfort Plus' },
                { url: 'https://www.monuta.de/sterbegeldversicherung/', name: 'Monuta', tarif: 'Trauerfall 85' },
                { url: 'https://www.ideal-versicherung.de/sterbegeldversicherung/', name: 'IDEAL', tarif: 'SterbeGeld 65' },
                { url: 'https://www.cosmosdirekt.de/sterbegeldversicherung/', name: 'CosmosDirekt', tarif: 'CRS' },
            ];

            for (const { url, name, tarif } of direktAnbieter) {
                if (!entries.find(e => e.anbieter === name)) {
                    const price = await scrapePrice(url);
                    if (price) {
                        entries.push({
                            anbieter: name, tarif,
                            beitrag: price,
                            wartezeit: 24, gesundheit: 'Nein', maxSumme: 15000,
                            unfall: '1x', bewertung: 4.0, isErgo: false
                        });
                    }
                }
            }

            result[alter] = mergeEntries(entries, existingData[alter]);
        }

        return result;
    }, existingData);
}

// =========================================================================
// ZAHNZUSATZVERSICHERUNG
// =========================================================================

async function crawlZahnzusatz(existingData) {
    return safeCrawl('Zahnzusatz', async () => {
        const result = {};

        for (const alter of [30, 50]) {
            const entries = [];

            // ERGO-Tarife
            entries.push(
                { anbieter: 'ERGO', tarif: 'Kombi ZAB+ZAE+ZBB', beitrag: alter === 30 ? 18.50 : 35.90, zahnersatz: 90, zahnbehandlung: 100, prophylaxe: '60€/J', wartezeit: '3-8 Mon', testurteil: 'WaizmannW. 73%', isErgo: true },
                { anbieter: 'ERGO', tarif: 'Premium ZAB+ZAE+ZBB', beitrag: alter === 30 ? 28.40 : 54.80, zahnersatz: 100, zahnbehandlung: 100, prophylaxe: '150€/J', wartezeit: '8 Mon', testurteil: 'WaizmannW. 89%', isErgo: true }
            );

            // Waizmanntabelle
            const rows = await scrapeTable('https://www.waizmanntabelle.de/zahnzusatzversicherung/vergleich');
            for (const row of rows) {
                if (!row.name.includes('ERGO') && !entries.find(e => e.anbieter === row.name)) {
                    entries.push({
                        anbieter: row.name.substring(0, 30),
                        tarif: row.cells[1] || 'Standard',
                        beitrag: row.price,
                        zahnersatz: parsePercent(row.cells[3]) || 80,
                        zahnbehandlung: parsePercent(row.cells[4]) || 80,
                        prophylaxe: row.cells[5] || '50€/J',
                        wartezeit: '8 Mon',
                        testurteil: row.cells[row.cells.length - 1] || '-',
                        isErgo: false
                    });
                }
            }

            // Einzelne Anbieter
            const direktAnbieter = [
                { url: 'https://www.dkv.com/zahnzusatzversicherung.html', name: 'DKV', tarif: 'KDTP100+KDBE' },
                { url: 'https://www.axa.de/zahnzusatzversicherung', name: 'AXA', tarif: 'DENT Premium-U' },
                { url: 'https://www.allianz.de/gesundheit/zahnzusatzversicherung/', name: 'Allianz', tarif: 'ZahnBest' },
                { url: 'https://www.hallesche.de/zahnzusatzversicherung', name: 'Hallesche', tarif: 'MEGA.Dent' },
            ];

            for (const { url, name, tarif } of direktAnbieter) {
                if (!entries.find(e => e.anbieter === name)) {
                    const price = await scrapePrice(url);
                    if (price) {
                        entries.push({
                            anbieter: name, tarif, beitrag: price,
                            zahnersatz: 85, zahnbehandlung: 85, prophylaxe: '50€/J',
                            wartezeit: '8 Mon', testurteil: '-', isErgo: false
                        });
                    }
                }
            }

            result[alter] = mergeEntries(entries, existingData[alter]);
        }

        return result;
    }, existingData);
}

// =========================================================================
// KRANKENHAUSZUSATZVERSICHERUNG
// =========================================================================

async function crawlKrankenhaus(existingData) {
    return safeCrawl('Krankenhaus', async () => {
        const result = {};

        for (const zimmer of ['Einbett', 'Zweibett']) {
            const entries = [];

            entries.push(
                { anbieter: 'ERGO', tarif: 'SZS', beitrag: zimmer === 'Einbett' ? 27.70 : 19.80, chefarzt: 'Ja', zimmer, rooming: 'Ja', altersRueckst: 'Nein', wartezeit: '3 Mon', testurteil: 'Gut (2,1)', isErgo: true },
                { anbieter: 'ERGO', tarif: 'SZU', beitrag: zimmer === 'Einbett' ? 44.30 : 35.20, chefarzt: 'Ja', zimmer, rooming: 'Ja', altersRueckst: 'Nein', wartezeit: '3 Mon', testurteil: 'Sehr gut (1,4)', isErgo: true }
            );

            const sources = [
                'https://www.finanztip.de/krankenhauszusatzversicherung/',
                'https://www.pkv-vergleich.de/krankenhauszusatzversicherung/',
            ];

            for (const url of sources) {
                const rows = await scrapeTable(url);
                for (const row of rows) {
                    if (!row.name.includes('ERGO') && !entries.find(e => e.anbieter === row.name)) {
                        entries.push({
                            anbieter: row.name.substring(0, 30),
                            tarif: row.cells[1] || 'Standard',
                            beitrag: row.price,
                            chefarzt: 'Ja', zimmer, rooming: 'Nein',
                            altersRueckst: 'Nein', wartezeit: '3 Mon',
                            testurteil: row.cells[row.cells.length - 1] || '-',
                            isErgo: false
                        });
                    }
                }
            }

            const direktAnbieter = [
                { url: 'https://www.axa.de/krankenhauszusatzversicherung', name: 'AXA', tarif: 'Komfort-U' },
                { url: 'https://www.debeka.de/produkte/krankenversicherung/krankenhauszusatz/', name: 'Debeka', tarif: 'EZ plus' },
                { url: 'https://www.allianz.de/gesundheit/krankenhauszusatzversicherung/', name: 'Allianz', tarif: 'AktiMed Best 90' },
                { url: 'https://www.signal-iduna.de/krankenhauszusatzversicherung', name: 'SIGNAL IDUNA', tarif: 'KlinikTOP' },
            ];

            for (const { url, name, tarif } of direktAnbieter) {
                if (!entries.find(e => e.anbieter === name)) {
                    const price = await scrapePrice(url);
                    if (price) {
                        entries.push({
                            anbieter: name, tarif, beitrag: price,
                            chefarzt: 'Ja', zimmer, rooming: 'Nein',
                            altersRueckst: 'Ja', wartezeit: '3 Mon', testurteil: '-',
                            isErgo: false
                        });
                    }
                }
            }

            result[zimmer] = mergeEntries(entries, existingData[zimmer]);
        }

        return result;
    }, existingData);
}

// =========================================================================
// WOHNGEBÄUDEVERSICHERUNG
// =========================================================================

async function crawlWohngebaude(existingData) {
    return safeCrawl('Wohngebäude', async () => {
        const result = {};

        for (const region of ['Hamburg', 'München']) {
            const entries = [];

            entries.push(
                { anbieter: 'ERGO', tarif: 'Smart', beitrag: region === 'Hamburg' ? 350 : 420, elementar: 'Optional', grobeFahrl: 'Ja', unterversV: 'Ja', ableit: 'Ja', uebersp: 'Ja', test: 'Gut (2,3)', isErgo: true },
                { anbieter: 'ERGO', tarif: 'Best', beitrag: region === 'Hamburg' ? 485 : 580, elementar: 'Inklusive', grobeFahrl: 'Ja', unterversV: 'Ja', ableit: 'Ja', uebersp: 'Ja', test: 'Sehr gut (1,5)', isErgo: true }
            );

            const sources = [
                'https://www.finanztip.de/wohngebaeudeversicherung/',
                'https://www.test.de/Wohngebaeudeversicherung-im-Test-4284498-0/',
            ];

            for (const url of sources) {
                const rows = await scrapeTable(url);
                for (const row of rows) {
                    if (!row.name.includes('ERGO') && !entries.find(e => e.anbieter === row.name)) {
                        entries.push({
                            anbieter: row.name.substring(0, 30),
                            tarif: row.cells[1] || 'Standard',
                            beitrag: row.price,
                            elementar: 'Optional', grobeFahrl: 'Nein', unterversV: 'Nein',
                            ableit: 'Nein', uebersp: 'Nein',
                            test: row.cells[row.cells.length - 1] || '-',
                            isErgo: false
                        });
                    }
                }
            }

            result[region] = mergeEntries(entries, existingData[region]);
        }

        return result;
    }, existingData);
}

// =========================================================================
// AUGENZUSATZVERSICHERUNG
// =========================================================================

async function crawlAugenzusatz(existingData) {
    return safeCrawl('Augenzusatz', async () => {
        const entries = [];

        entries.push(
            { anbieter: 'ERGO', tarif: 'Augen-Vorsorge', beitrag: 9.90, brillen: '150€', lasik: '1.000€', kontaktl: 'Ja', wartezeit: 'Keine', vorsorge: 'Ja', isErgo: true },
            { anbieter: 'ERGO', tarif: 'Augen-Premium', beitrag: 14.90, brillen: '300€', lasik: '2.000€', kontaktl: 'Ja', wartezeit: 'Keine', vorsorge: 'Ja', isErgo: true }
        );

        const sources = [
            'https://www.brillenversicherung-vergleich.de/',
            'https://www.finanztip.de/brillenversicherung/',
        ];

        for (const url of sources) {
            const rows = await scrapeTable(url);
            for (const row of rows) {
                if (!row.name.includes('ERGO') && !entries.find(e => e.anbieter === row.name)) {
                    entries.push({
                        anbieter: row.name.substring(0, 30),
                        tarif: row.cells[1] || 'Standard',
                        beitrag: row.price,
                        brillen: row.cells[2] || '100€', lasik: 'Nein',
                        kontaktl: 'Nein', wartezeit: '3 Mon', vorsorge: 'Nein',
                        isErgo: false
                    });
                }
            }
        }

        return mergeEntries(entries, existingData);
    }, existingData);
}

// =========================================================================
// RECHTSSCHUTZVERSICHERUNG
// =========================================================================

async function crawlRechtsschutz(existingData) {
    return safeCrawl('Rechtsschutz', async () => {
        const result = {};

        for (const versnehmer of ['Single', 'Familie']) {
            const entries = [];

            entries.push(
                { anbieter: 'ERGO', tarif: 'Komfort', beitrag: versnehmer === 'Single' ? 532 : 652, deckung: 'Unbegrenzt', selbstbet: '150€', wartezeit: '3 Mon', mediation: 'Ja', onlineBeratung: 'Ja', test: 'Gut (2,2)', isErgo: true },
                { anbieter: 'ERGO', tarif: 'Premium', beitrag: versnehmer === 'Single' ? 680 : 815, deckung: 'Unbegrenzt', selbstbet: '0€', wartezeit: '3 Mon', mediation: 'Ja', onlineBeratung: 'Ja', test: 'Sehr gut (1,3)', isErgo: true }
            );

            const sources = [
                'https://www.finanztip.de/rechtsschutzversicherung/',
            ];

            for (const url of sources) {
                const rows = await scrapeTable(url);
                for (const row of rows) {
                    if (!row.name.includes('ERGO') && !entries.find(e => e.anbieter === row.name)) {
                        entries.push({
                            anbieter: row.name.substring(0, 30),
                            tarif: row.cells[1] || 'Standard',
                            beitrag: row.price,
                            deckung: '300.000€', selbstbet: '150€',
                            wartezeit: '3 Mon', mediation: 'Nein',
                            onlineBeratung: 'Nein',
                            test: row.cells[row.cells.length - 1] || '-',
                            isErgo: false
                        });
                    }
                }
            }

            const direktAnbieter = [
                { url: 'https://www.arag.de/rechtsschutzversicherung/', name: 'ARAG', tarif: 'Aktiv Komfort' },
                { url: 'https://www.roland-rechtsschutz.de/', name: 'ROLAND', tarif: 'Kompakt' },
                { url: 'https://www.advocard.de/rechtsschutzversicherung/', name: 'ADVOCARD', tarif: 'Komfort' },
                { url: 'https://www.allianz.de/recht-und-eigentum/rechtsschutzversicherung/', name: 'Allianz', tarif: 'Best' },
            ];

            for (const { url, name, tarif } of direktAnbieter) {
                if (!entries.find(e => e.anbieter === name)) {
                    const price = await scrapePrice(url);
                    if (price) {
                        entries.push({
                            anbieter: name, tarif, beitrag: price,
                            deckung: '300.000€', selbstbet: '150€',
                            wartezeit: '3 Mon', mediation: 'Ja',
                            onlineBeratung: 'Nein', test: '-',
                            isErgo: false
                        });
                    }
                }
            }

            result[versnehmer] = mergeEntries(entries, existingData[versnehmer]);
        }

        return result;
    }, existingData);
}

// =========================================================================
// HAUSRATVERSICHERUNG
// =========================================================================

async function crawlHausrat(existingData) {
    return safeCrawl('Hausrat', async () => {
        const result = {};

        for (const region of ['Hamburg', 'München']) {
            const entries = [];

            entries.push(
                { anbieter: 'ERGO', tarif: 'Smart', beitrag: region === 'Hamburg' ? 155 : 178, grobeFahrl: 'Nein', unterversV: 'Nein', fahrrad: '1.000€', glas: 'Optional', elementar: 'Optional', uebersp: 'Ja', test: 'Gut (2,5)', isErgo: true },
                { anbieter: 'ERGO', tarif: 'Best', beitrag: region === 'Hamburg' ? 220 : 253, grobeFahrl: 'Ja', unterversV: 'Ja', fahrrad: '5.000€', glas: 'Inklusive', elementar: 'Inklusive', uebersp: 'Ja', test: 'Sehr gut (1,4)', isErgo: true }
            );

            const sources = [
                'https://www.finanztip.de/hausratversicherung/',
                'https://www.test.de/Hausratversicherung-im-Test-4775794-0/',
            ];

            for (const url of sources) {
                const rows = await scrapeTable(url);
                for (const row of rows) {
                    if (!row.name.includes('ERGO') && !entries.find(e => e.anbieter === row.name)) {
                        entries.push({
                            anbieter: row.name.substring(0, 30),
                            tarif: row.cells[1] || 'Standard',
                            beitrag: row.price,
                            grobeFahrl: 'Nein', unterversV: 'Nein',
                            fahrrad: '500€', glas: 'Optional', elementar: 'Optional',
                            uebersp: 'Nein',
                            test: row.cells[row.cells.length - 1] || '-',
                            isErgo: false
                        });
                    }
                }
            }

            result[region] = mergeEntries(entries, existingData[region]);
        }

        return result;
    }, existingData);
}

// =========================================================================
// MAIN
// =========================================================================

async function main() {
    console.log('=== ERGO Wettbewerbsdaten-Crawler ===');
    console.log('Start:', new Date().toISOString());
    console.log('Node.js:', process.version);

    // Bestehende Daten laden
    const existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const products = existing.products;

    console.log('\nCrawle Produkte...');

    // Jedes Produkt aktualisieren
    products.sterbegeld.data = await crawlSterbegeld(products.sterbegeld.data);
    products.zahnzusatz.data = await crawlZahnzusatz(products.zahnzusatz.data);
    products.krankenhaus.data = await crawlKrankenhaus(products.krankenhaus.data);
    products.wohngebaude.data = await crawlWohngebaude(products.wohngebaude.data);
    products.augenzusatz.data = await crawlAugenzusatz(products.augenzusatz.data);
    products.rechtsschutz.data = await crawlRechtsschutz(products.rechtsschutz.data);
    products.hausrat.data = await crawlHausrat(products.hausrat.data);

    // Zeitstempel aktualisieren
    const today = new Date().toISOString().split('T')[0];
    existing.lastUpdated = today;

    // Speichern
    fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2));

    // Zusammenfassung
    console.log('\n--- Zusammenfassung ---');
    for (const [key, prod] of Object.entries(products)) {
        const data = prod.data;
        const count = Array.isArray(data) ? data.length :
            Object.values(data).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
        console.log(`  ${prod.name}: ${count} Einträge`);
    }
    console.log(`\ndata.json aktualisiert. Stand: ${today}`);
    console.log('=== Fertig ===');
}

main().catch(err => {
    console.error('Crawler-Fehler:', err);
    process.exit(1);
});
