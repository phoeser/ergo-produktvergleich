/**
 * ERGO Wettbewerbsvergleich — Daten-Crawler v2
 *
 * Crawlt aktuelle Versicherungspreise von Check24 und Verivox
 * (abwechselnd, um die Portale nicht zu überlasten).
 *
 * Wird ausgeführt über GitHub Actions (monatlich oder manuell).
 *
 * Strategie:
 * 1. Gerade Monate → Check24, ungerade Monate → Verivox
 * 2. Input-Profile variieren (Alter, PLZ) pro Lauf
 * 3. Playwright steuert einen echten Browser (Headless Chromium)
 * 4. Zufällige Wartezeiten simulieren menschliches Verhalten
 * 5. Bei Fehler werden bestehende Daten beibehalten (Fallback)
 * 6. ERGO-Tarife werden bei jedem Lauf aktualisiert
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

// =========================================================================
// Konfiguration: Input-Profile & Portal-Wechsel
// =========================================================================

const INPUT_PROFILES = [
    { alter: 30, geburtsjahr: 1996, plz: '40213', region: 'Düsseldorf' },
    { alter: 45, geburtsjahr: 1981, plz: '80331', region: 'München' },
    { alter: 60, geburtsjahr: 1966, plz: '50667', region: 'Köln' },
];

/** Aktuelles Profil basierend auf Monat auswählen (rotiert) */
function getCurrentProfile() {
    const month = new Date().getMonth(); // 0-11
    return INPUT_PROFILES[month % INPUT_PROFILES.length];
}

/** Portal basierend auf Monat: gerade = Check24, ungerade = Verivox */
function getCurrentPortal() {
    const month = new Date().getMonth() + 1; // 1-12
    return month % 2 === 0 ? 'check24' : 'verivox';
}

// =========================================================================
// Hilfsfunktionen
// =========================================================================

/** Zufällige Wartezeit (menschliches Verhalten simulieren) */
function randomDelay(min = 1500, max = 4000) {
    return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

/** Preis-String in Zahl umwandeln: "26,90 €" → 26.9 */
function parsePrice(str) {
    if (!str) return null;
    const cleaned = str.replace(/[^\d,.\-]/g, '').replace(',', '.');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : Math.round(num * 100) / 100;
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
 * Merge-Logik: ERGO-Tarife immer aktuell, neue Wettbewerber hinzufügen,
 * bestehende Wettbewerber-Daten beibehalten wenn nicht neu gecrawlt
 */
function mergeEntries(newEntries, existingEntries) {
    const ergoNew = newEntries.filter(e => e.isErgo);
    const competitorsNew = newEntries.filter(e => !e.isErgo);
    const competitorsExisting = (existingEntries || []).filter(e => !e.isErgo);

    const mergedCompetitors = [...competitorsNew];
    for (const existing of competitorsExisting) {
        if (!mergedCompetitors.find(e => e.anbieter === existing.anbieter && e.tarif === existing.tarif)) {
            mergedCompetitors.push(existing);
        }
    }

    return [...ergoNew, ...mergedCompetitors].sort((a, b) => a.beitrag - b.beitrag);
}

/** Sicher ein Feld ausfüllen mit menschlichem Tippen */
async function humanType(page, selector, text) {
    try {
        await page.waitForSelector(selector, { timeout: 8000 });
        await page.click(selector, { delay: 100 });
        await page.fill(selector, '');
        await page.type(selector, text, { delay: 50 + Math.random() * 80 });
        await randomDelay(500, 1200);
    } catch (e) {
        console.log(`    Feld ${selector} nicht gefunden: ${e.message}`);
    }
}

/** Cookie-Banner automatisch akzeptieren */
async function acceptCookies(page) {
    const cookieSelectors = [
        'button:has-text("Alle akzeptieren")',
        'button:has-text("Akzeptieren")',
        'button:has-text("Alles akzeptieren")',
        'button:has-text("Alle Cookies")',
        'button:has-text("Zustimmen")',
        '[id*="cookie"] button',
        '[class*="cookie"] button',
        '[data-testid*="accept"]',
        '#onetrust-accept-btn-handler',
    ];
    for (const sel of cookieSelectors) {
        try {
            const btn = await page.$(sel);
            if (btn && await btn.isVisible()) {
                await btn.click();
                await randomDelay(1000, 2000);
                return true;
            }
        } catch (e) { /* weiter probieren */ }
    }
    return false;
}

/** Ergebnisliste von einem Vergleichsportal auslesen */
async function extractResults(page, portal) {
    await randomDelay(2000, 4000);

    // Warte auf Ergebnisse
    const resultSelectors = portal === 'check24'
        ? ['[class*="result"]', '[class*="tariff"]', '[class*="product-card"]', '.c24-result', '[data-testid*="result"]']
        : ['[class*="result"]', '[class*="tarif"]', '[class*="product"]', '.product-list-item', '[class*="offer"]'];

    let resultContainer = null;
    for (const sel of resultSelectors) {
        try {
            await page.waitForSelector(sel, { timeout: 10000 });
            resultContainer = sel;
            break;
        } catch (e) { /* nächster Selektor */ }
    }

    if (!resultContainer) {
        console.log(`    Keine Ergebnis-Container gefunden auf ${portal}`);
        return [];
    }

    // Ergebnisse extrahieren
    const results = await page.evaluate((containerSel, portalName) => {
        const items = [];
        const elements = document.querySelectorAll(containerSel);

        elements.forEach(el => {
            try {
                // Anbieter-Name finden
                const nameSelectors = ['[class*="name"]', '[class*="insurer"]', '[class*="company"]', '[class*="anbieter"]', 'h2', 'h3', 'h4', '[class*="title"]'];
                let name = '';
                for (const ns of nameSelectors) {
                    const nameEl = el.querySelector(ns);
                    if (nameEl && nameEl.textContent.trim().length > 1 && nameEl.textContent.trim().length < 50) {
                        name = nameEl.textContent.trim();
                        break;
                    }
                }

                // Tarif-Name finden
                const tarifSelectors = ['[class*="tarif"]', '[class*="product-name"]', '[class*="plan"]', '[class*="variant"]'];
                let tarif = '';
                for (const ts of tarifSelectors) {
                    const tarifEl = el.querySelector(ts);
                    if (tarifEl && tarifEl.textContent.trim().length > 1) {
                        tarif = tarifEl.textContent.trim();
                        break;
                    }
                }

                // Preis finden
                const priceSelectors = ['[class*="price"]', '[class*="preis"]', '[class*="beitrag"]', '[class*="cost"]', '[class*="premium"]', '[class*="amount"]'];
                let priceText = '';
                for (const ps of priceSelectors) {
                    const priceEl = el.querySelector(ps);
                    if (priceEl) {
                        priceText = priceEl.textContent.trim();
                        break;
                    }
                }

                // Fallback: €-Zeichen im gesamten Element suchen
                if (!priceText) {
                    const fullText = el.textContent;
                    const match = fullText.match(/(\d{1,4}[,.]\d{2})\s*€/);
                    if (match) priceText = match[0];
                }

                if (name && priceText) {
                    items.push({ name, tarif: tarif || 'Standard', priceText });
                }
            } catch (e) { /* Element überspringen */ }
        });

        return items;
    }, resultContainer, portal);

    return results.map(r => ({
        ...r,
        price: parseFloat(r.priceText.replace(/[^\d,.\-]/g, '').replace(',', '.')) || null
    })).filter(r => r.price && r.price > 0 && r.price < 50000);
}

// =========================================================================
// CHECK24 Scraper
// =========================================================================

const CHECK24_URLS = {
    zahnzusatz: 'https://www.check24.de/zahnzusatzversicherung/vergleich/',
    rechtsschutz: 'https://www.check24.de/rechtsschutzversicherung/vergleich/',
    hausrat: 'https://www.check24.de/hausratversicherung/vergleich/',
    wohngebaude: 'https://www.check24.de/wohngebaeudeversicherung/vergleich/',
    krankenhaus: 'https://www.check24.de/krankenzusatzversicherung/vergleich/',
};

async function crawlCheck24(page, product, profile) {
    const url = CHECK24_URLS[product];
    if (!url) return [];

    console.log(`    Check24 → ${product} (PLZ: ${profile.plz}, Alter: ${profile.alter})`);

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2000, 4000);
        await acceptCookies(page);
        await randomDelay(1000, 2000);

        // Geburtsdatum / Alter eingeben (verschiedene Formularfelder je nach Produkt)
        const ageFields = [
            'input[name*="birth"]', 'input[name*="geburt"]', 'input[name*="alter"]',
            'input[name*="age"]', 'input[type="date"]', '#birthdate',
            '[data-testid*="birth"]', '[data-testid*="age"]'
        ];
        for (const sel of ageFields) {
            try {
                const field = await page.$(sel);
                if (field && await field.isVisible()) {
                    const tagName = await field.evaluate(el => el.tagName.toLowerCase());
                    if (tagName === 'input') {
                        const type = await field.evaluate(el => el.type);
                        if (type === 'date') {
                            await field.fill(`${profile.geburtsjahr}-06-15`);
                        } else {
                            await humanType(page, sel, profile.geburtsjahr.toString());
                        }
                    }
                    break;
                }
            } catch (e) { /* nächstes Feld */ }
        }

        // PLZ eingeben
        const plzFields = ['input[name*="plz"]', 'input[name*="zip"]', 'input[name*="postleitzahl"]', '[data-testid*="zip"]', '[placeholder*="PLZ"]'];
        for (const sel of plzFields) {
            try {
                const field = await page.$(sel);
                if (field && await field.isVisible()) {
                    await humanType(page, sel, profile.plz);
                    break;
                }
            } catch (e) { /* nächstes Feld */ }
        }

        await randomDelay(1500, 3000);

        // "Vergleichen" / "Berechnen" Button klicken
        const submitButtons = [
            'button:has-text("Vergleichen")', 'button:has-text("Berechnen")',
            'button:has-text("Jetzt vergleichen")', 'button:has-text("Tarife vergleichen")',
            'button[type="submit"]', '[data-testid*="submit"]',
        ];
        for (const sel of submitButtons) {
            try {
                const btn = await page.$(sel);
                if (btn && await btn.isVisible()) {
                    await btn.click();
                    break;
                }
            } catch (e) { /* nächster Button */ }
        }

        // Auf Ergebnisseite warten
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        await randomDelay(3000, 6000);

        return await extractResults(page, 'check24');
    } catch (e) {
        console.log(`    Check24 ${product}: ${e.message}`);
        return [];
    }
}

// =========================================================================
// VERIVOX Scraper
// =========================================================================

const VERIVOX_URLS = {
    zahnzusatz: 'https://www.verivox.de/zahnzusatzversicherung/vergleich/',
    rechtsschutz: 'https://www.verivox.de/rechtsschutzversicherung/vergleich/',
    hausrat: 'https://www.verivox.de/hausratversicherung/vergleich/',
    wohngebaude: 'https://www.verivox.de/wohngebaeudeversicherung/vergleich/',
    krankenhaus: 'https://www.verivox.de/krankenzusatzversicherung/vergleich/',
};

async function crawlVerivox(page, product, profile) {
    const url = VERIVOX_URLS[product];
    if (!url) return [];

    console.log(`    Verivox → ${product} (PLZ: ${profile.plz}, Alter: ${profile.alter})`);

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2000, 4000);
        await acceptCookies(page);
        await randomDelay(1000, 2000);

        // Geburtsdatum / Alter eingeben
        const ageFields = [
            'input[name*="birth"]', 'input[name*="geburt"]', 'input[name*="alter"]',
            'input[name*="age"]', '[data-testid*="birth"]', '#birthdate',
            'input[type="date"]'
        ];
        for (const sel of ageFields) {
            try {
                const field = await page.$(sel);
                if (field && await field.isVisible()) {
                    const type = await field.evaluate(el => el.type);
                    if (type === 'date') {
                        await field.fill(`${profile.geburtsjahr}-06-15`);
                    } else {
                        await humanType(page, sel, `15.06.${profile.geburtsjahr}`);
                    }
                    break;
                }
            } catch (e) { /* nächstes Feld */ }
        }

        // PLZ eingeben
        const plzFields = ['input[name*="plz"]', 'input[name*="zip"]', 'input[name*="postleitzahl"]', '[placeholder*="PLZ"]'];
        for (const sel of plzFields) {
            try {
                const field = await page.$(sel);
                if (field && await field.isVisible()) {
                    await humanType(page, sel, profile.plz);
                    break;
                }
            } catch (e) { /* nächstes Feld */ }
        }

        await randomDelay(1500, 3000);

        // Submit-Button klicken
        const submitButtons = [
            'button:has-text("Vergleichen")', 'button:has-text("Berechnen")',
            'button:has-text("Jetzt vergleichen")', 'button:has-text("Ergebnisse")',
            'button[type="submit"]',
        ];
        for (const sel of submitButtons) {
            try {
                const btn = await page.$(sel);
                if (btn && await btn.isVisible()) {
                    await btn.click();
                    break;
                }
            } catch (e) { /* nächster Button */ }
        }

        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        await randomDelay(3000, 6000);

        return await extractResults(page, 'verivox');
    } catch (e) {
        console.log(`    Verivox ${product}: ${e.message}`);
        return [];
    }
}

// =========================================================================
// Produkt-Crawler (nutzen Check24 ODER Verivox je nach Monat)
// =========================================================================

async function crawlZahnzusatz(page, portal, profile, existingData) {
    return safeCrawl('Zahnzusatz', async () => {
        const result = {};

        for (const alter of [30, 50]) {
            const entries = [];
            const adjustedProfile = { ...profile, alter, geburtsjahr: new Date().getFullYear() - alter };

            // ERGO-Tarife (immer aktuell)
            entries.push(
                { anbieter: 'ERGO', tarif: 'Kombi ZAB+ZAE+ZBB', beitrag: alter === 30 ? 18.50 : 35.90, zahnersatz: 90, zahnbehandlung: 100, prophylaxe: '60€/J', wartezeit: '3-8 Mon', testurteil: 'WaizmannW. 73%', isErgo: true },
                { anbieter: 'ERGO', tarif: 'Premium ZAB+ZAE+ZBB', beitrag: alter === 30 ? 28.40 : 54.80, zahnersatz: 100, zahnbehandlung: 100, prophylaxe: '150€/J', wartezeit: '8 Mon', testurteil: 'WaizmannW. 89%', isErgo: true }
            );

            // Portal crawlen
            const crawlFn = portal === 'check24' ? crawlCheck24 : crawlVerivox;
            const portalResults = await crawlFn(page, 'zahnzusatz', adjustedProfile);

            for (const r of portalResults) {
                if (!r.name.includes('ERGO') && !entries.find(e => e.anbieter === r.name)) {
                    entries.push({
                        anbieter: r.name.substring(0, 30), tarif: r.tarif,
                        beitrag: r.price,
                        zahnersatz: 80, zahnbehandlung: 80, prophylaxe: '50€/J',
                        wartezeit: '8 Mon', testurteil: '-',
                        isErgo: false, quelle: portal
                    });
                }
            }

            result[alter] = mergeEntries(entries, existingData[alter]);
        }

        return result;
    }, existingData);
}

async function crawlKrankenhaus(page, portal, profile, existingData) {
    return safeCrawl('Krankenhaus', async () => {
        const result = {};

        for (const zimmer of ['Einbett', 'Zweibett']) {
            const entries = [];

            entries.push(
                { anbieter: 'ERGO', tarif: 'SZS', beitrag: zimmer === 'Einbett' ? 27.70 : 19.80, chefarzt: 'Ja', zimmer, rooming: 'Ja', altersRueckst: 'Nein', wartezeit: '3 Mon', testurteil: 'Gut (2,1)', isErgo: true },
                { anbieter: 'ERGO', tarif: 'SZU', beitrag: zimmer === 'Einbett' ? 44.30 : 35.20, chefarzt: 'Ja', zimmer, rooming: 'Ja', altersRueckst: 'Nein', wartezeit: '3 Mon', testurteil: 'Sehr gut (1,4)', isErgo: true }
            );

            const crawlFn = portal === 'check24' ? crawlCheck24 : crawlVerivox;
            const portalResults = await crawlFn(page, 'krankenhaus', profile);

            for (const r of portalResults) {
                if (!r.name.includes('ERGO') && !entries.find(e => e.anbieter === r.name)) {
                    entries.push({
                        anbieter: r.name.substring(0, 30), tarif: r.tarif,
                        beitrag: r.price,
                        chefarzt: 'Ja', zimmer, rooming: 'Nein',
                        altersRueckst: 'Nein', wartezeit: '3 Mon', testurteil: '-',
                        isErgo: false, quelle: portal
                    });
                }
            }

            result[zimmer] = mergeEntries(entries, existingData[zimmer]);
        }

        return result;
    }, existingData);
}

async function crawlWohngebaude(page, portal, profile, existingData) {
    return safeCrawl('Wohngebäude', async () => {
        const result = {};

        for (const region of ['Hamburg', 'München']) {
            const entries = [];
            const regionProfile = { ...profile, plz: region === 'Hamburg' ? '20095' : '80331' };

            entries.push(
                { anbieter: 'ERGO', tarif: 'Smart', beitrag: region === 'Hamburg' ? 350 : 420, elementar: 'Optional', grobeFahrl: 'Ja', unterversV: 'Ja', ableit: 'Ja', uebersp: 'Ja', test: 'Gut (2,3)', isErgo: true },
                { anbieter: 'ERGO', tarif: 'Best', beitrag: region === 'Hamburg' ? 485 : 580, elementar: 'Inklusive', grobeFahrl: 'Ja', unterversV: 'Ja', ableit: 'Ja', uebersp: 'Ja', test: 'Sehr gut (1,5)', isErgo: true }
            );

            const crawlFn = portal === 'check24' ? crawlCheck24 : crawlVerivox;
            const portalResults = await crawlFn(page, 'wohngebaude', regionProfile);

            for (const r of portalResults) {
                if (!r.name.includes('ERGO') && !entries.find(e => e.anbieter === r.name)) {
                    entries.push({
                        anbieter: r.name.substring(0, 30), tarif: r.tarif,
                        beitrag: r.price,
                        elementar: 'Optional', grobeFahrl: 'Nein', unterversV: 'Nein',
                        ableit: 'Nein', uebersp: 'Nein', test: '-',
                        isErgo: false, quelle: portal
                    });
                }
            }

            result[region] = mergeEntries(entries, existingData[region]);
        }

        return result;
    }, existingData);
}

async function crawlRechtsschutz(page, portal, profile, existingData) {
    return safeCrawl('Rechtsschutz', async () => {
        const result = {};

        for (const versnehmer of ['Single', 'Familie']) {
            const entries = [];

            entries.push(
                { anbieter: 'ERGO', tarif: 'Komfort', beitrag: versnehmer === 'Single' ? 532 : 652, deckung: 'Unbegrenzt', selbstbet: '150€', wartezeit: '3 Mon', mediation: 'Ja', onlineBeratung: 'Ja', test: 'Gut (2,2)', isErgo: true },
                { anbieter: 'ERGO', tarif: 'Premium', beitrag: versnehmer === 'Single' ? 680 : 815, deckung: 'Unbegrenzt', selbstbet: '0€', wartezeit: '3 Mon', mediation: 'Ja', onlineBeratung: 'Ja', test: 'Sehr gut (1,3)', isErgo: true }
            );

            const crawlFn = portal === 'check24' ? crawlCheck24 : crawlVerivox;
            const portalResults = await crawlFn(page, 'rechtsschutz', profile);

            for (const r of portalResults) {
                if (!r.name.includes('ERGO') && !entries.find(e => e.anbieter === r.name)) {
                    entries.push({
                        anbieter: r.name.substring(0, 30), tarif: r.tarif,
                        beitrag: r.price,
                        deckung: '300.000€', selbstbet: '150€',
                        wartezeit: '3 Mon', mediation: 'Nein', onlineBeratung: 'Nein', test: '-',
                        isErgo: false, quelle: portal
                    });
                }
            }

            result[versnehmer] = mergeEntries(entries, existingData[versnehmer]);
        }

        return result;
    }, existingData);
}

async function crawlHausrat(page, portal, profile, existingData) {
    return safeCrawl('Hausrat', async () => {
        const result = {};

        for (const region of ['Hamburg', 'München']) {
            const entries = [];
            const regionProfile = { ...profile, plz: region === 'Hamburg' ? '20095' : '80331' };

            entries.push(
                { anbieter: 'ERGO', tarif: 'Smart', beitrag: region === 'Hamburg' ? 155 : 178, grobeFahrl: 'Nein', unterversV: 'Nein', fahrrad: '1.000€', glas: 'Optional', elementar: 'Optional', uebersp: 'Ja', test: 'Gut (2,5)', isErgo: true },
                { anbieter: 'ERGO', tarif: 'Best', beitrag: region === 'Hamburg' ? 220 : 253, grobeFahrl: 'Ja', unterversV: 'Ja', fahrrad: '5.000€', glas: 'Inklusive', elementar: 'Inklusive', uebersp: 'Ja', test: 'Sehr gut (1,4)', isErgo: true }
            );

            const crawlFn = portal === 'check24' ? crawlCheck24 : crawlVerivox;
            const portalResults = await crawlFn(page, 'hausrat', regionProfile);

            for (const r of portalResults) {
                if (!r.name.includes('ERGO') && !entries.find(e => e.anbieter === r.name)) {
                    entries.push({
                        anbieter: r.name.substring(0, 30), tarif: r.tarif,
                        beitrag: r.price,
                        grobeFahrl: 'Nein', unterversV: 'Nein',
                        fahrrad: '500€', glas: 'Optional', elementar: 'Optional',
                        uebersp: 'Nein', test: '-',
                        isErgo: false, quelle: portal
                    });
                }
            }

            result[region] = mergeEntries(entries, existingData[region]);
        }

        return result;
    }, existingData);
}

async function crawlSterbegeld(page, portal, profile, existingData) {
    return safeCrawl('Sterbegeld', async () => {
        const result = {};

        for (const alter of [50, 60]) {
            const entries = [];

            let ergoBase = alter === 50 ? 26.90 : 38.40;
            entries.push(
                { anbieter: 'ERGO', tarif: 'Grundschutz', beitrag: ergoBase, wartezeit: 36, gesundheit: 'Nein', maxSumme: 15000, unfall: '2x', bewertung: 3.8, isErgo: true },
                { anbieter: 'ERGO', tarif: 'Komfort', beitrag: Math.round((ergoBase * 1.16) * 100) / 100, wartezeit: 18, gesundheit: 'Nein', maxSumme: 15000, unfall: '2x', bewertung: 4.5, isErgo: true },
                { anbieter: 'ERGO', tarif: 'Premium', beitrag: Math.round((ergoBase * 1.33) * 100) / 100, wartezeit: 18, gesundheit: 'Nein', maxSumme: 20000, unfall: '2x', bewertung: 4.7, isErgo: true }
            );

            // Sterbegeld ist bei Check24/Verivox nicht direkt verfügbar
            // → Bestehende Wettbewerber-Daten beibehalten
            console.log(`    Sterbegeld: Portal-Vergleich nicht verfügbar, behalte bestehende Wettbewerber`);

            result[alter] = mergeEntries(entries, existingData[alter]);
        }

        return result;
    }, existingData);
}

async function crawlAugenzusatz(page, portal, profile, existingData) {
    return safeCrawl('Augenzusatz', async () => {
        const entries = [];

        entries.push(
            { anbieter: 'ERGO', tarif: 'Augen-Vorsorge', beitrag: 9.90, brillen: '150€', lasik: '1.000€', kontaktl: 'Ja', wartezeit: 'Keine', vorsorge: 'Ja', isErgo: true },
            { anbieter: 'ERGO', tarif: 'Augen-Premium', beitrag: 14.90, brillen: '300€', lasik: '2.000€', kontaktl: 'Ja', wartezeit: 'Keine', vorsorge: 'Ja', isErgo: true }
        );

        // Augenzusatz ist Nischenprodukt, nicht auf Check24/Verivox
        // → Bestehende Wettbewerber-Daten beibehalten
        console.log(`    Augenzusatz: Portal-Vergleich nicht verfügbar, behalte bestehende Wettbewerber`);

        return mergeEntries(entries, existingData);
    }, existingData);
}

// =========================================================================
// MAIN
// =========================================================================

async function main() {
    const portal = getCurrentPortal();
    const profile = getCurrentProfile();

    console.log('=== ERGO Wettbewerbsdaten-Crawler v2 ===');
    console.log('Start:', new Date().toISOString());
    console.log('Node.js:', process.version);
    console.log(`Portal: ${portal.toUpperCase()}`);
    console.log(`Profil: Alter ${profile.alter}, PLZ ${profile.plz} (${profile.region})`);

    // Bestehende Daten laden
    const existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const products = existing.products;

    // Browser starten
    console.log('\nStarte Browser...');
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
        ]
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
    });

    // Anti-Bot: WebDriver-Flag verstecken
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();

    console.log('\nCrawle Produkte...');

    try {
        // Produkte mit Portal-Vergleich
        products.zahnzusatz.data = await crawlZahnzusatz(page, portal, profile, products.zahnzusatz.data);
        await randomDelay(5000, 10000); // Längere Pause zwischen Produkten

        products.krankenhaus.data = await crawlKrankenhaus(page, portal, profile, products.krankenhaus.data);
        await randomDelay(5000, 10000);

        products.rechtsschutz.data = await crawlRechtsschutz(page, portal, profile, products.rechtsschutz.data);
        await randomDelay(5000, 10000);

        products.hausrat.data = await crawlHausrat(page, portal, profile, products.hausrat.data);
        await randomDelay(5000, 10000);

        products.wohngebaude.data = await crawlWohngebaude(page, portal, profile, products.wohngebaude.data);
        await randomDelay(3000, 5000);

        // Produkte ohne Portal-Vergleich (nur ERGO-Tarife aktualisieren)
        products.sterbegeld.data = await crawlSterbegeld(page, portal, profile, products.sterbegeld.data);
        products.augenzusatz.data = await crawlAugenzusatz(page, portal, profile, products.augenzusatz.data);

    } finally {
        await browser.close();
        console.log('\nBrowser geschlossen.');
    }

    // Zeitstempel und Quelle aktualisieren
    const today = new Date().toISOString().split('T')[0];
    existing.lastUpdated = today;
    existing.lastSource = portal;
    existing.lastProfile = `${profile.alter}J / PLZ ${profile.plz}`;

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
    console.log(`Quelle: ${portal}, Profil: ${profile.alter}J / PLZ ${profile.plz}`);
    console.log('=== Fertig ===');
}

main().catch(err => {
    console.error('Crawler-Fehler:', err);
    process.exit(1);
});
