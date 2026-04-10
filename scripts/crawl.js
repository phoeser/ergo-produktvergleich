/**
 * ERGO Wettbewerbsvergleich — Daten-Crawler
 *
 * Dieses Script crawlt aktuelle Versicherungspreise von Anbieter-Webseiten
 * und Vergleichsportalen und aktualisiert data.json.
 *
 * Wird ausgeführt über GitHub Actions (monatlich oder manuell).
 *
 * Erweiterbar: Für jedes Produkt kann eine eigene Crawl-Funktion
 * hinzugefügt werden, die spezifische Quellen abfragt.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

async function crawlSterbegeld(existingData) {
    console.log('  Sterbegeld: Behalte bestehende Daten (Crawl-Logik noch nicht implementiert)');
    return existingData;
}

async function crawlZahnzusatz(existingData) {
    console.log('  Zahnzusatz: Behalte bestehende Daten (Crawl-Logik noch nicht implementiert)');
    return existingData;
}

async function crawlKrankenhaus(existingData) {
    console.log('  Krankenhaus: Behalte bestehende Daten (Crawl-Logik noch nicht implementiert)');
    return existingData;
}

async function crawlWohngebaude(existingData) {
    console.log('  Wohngebaeude: Behalte bestehende Daten (Crawl-Logik noch nicht implementiert)');
    return existingData;
}

async function crawlAugenzusatz(existingData) {
    console.log('  Augenzusatz: Behalte bestehende Daten (Crawl-Logik noch nicht implementiert)');
    return existingData;
}

async function crawlRechtsschutz(existingData) {
    console.log('  Rechtsschutz: Behalte bestehende Daten (Crawl-Logik noch nicht implementiert)');
    return existingData;
}

async function crawlHausrat(existingData) {
    console.log('  Hausrat: Behalte bestehende Daten (Crawl-Logik noch nicht implementiert)');
    return existingData;
}

async function main() {
    console.log('=== ERGO Wettbewerbsdaten-Crawler ===');
    console.log('Start:', new Date().toISOString());
    const existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const products = existing.products;
    console.log('\nCrawle Produkte...');
    products.sterbegeld.data = await crawlSterbegeld(products.sterbegeld.data);
    products.zahnzusatz.data = await crawlZahnzusatz(products.zahnzusatz.data);
    products.krankenhaus.data = await crawlKrankenhaus(products.krankenhaus.data);
    products.wohngebaude.data = await crawlWohngebaude(products.wohngebaude.data);
    products.augenzusatz.data = await crawlAugenzusatz(products.augenzusatz.data);
    products.rechtsschutz.data = await crawlRechtsschutz(products.rechtsschutz.data);
    products.hausrat.data = await crawlHausrat(products.hausrat.data);
    const today = new Date().toISOString().split('T')[0];
    existing.lastUpdated = today;
    fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2));
    console.log('\ndata.json aktualisiert. Stand:', today);
    console.log('=== Fertig ===');
}

main().catch(err => {
    console.error('Crawler-Fehler:', err);
    process.exit(1);
});
