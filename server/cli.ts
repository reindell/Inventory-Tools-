import { createDatabase, migrate } from './db.js';
import { seed } from './seed.js';
import { reconcile } from './inventory.js';
import { config } from './config.js';
import { importSampleCatalog, loadSampleCatalog, sampleAvailable } from './sample-catalog.js';
const db = await createDatabase();
try {
  const command = process.argv[2];
  if (command === 'setup') {
    await migrate(db);
    await seed(db);
    console.info('Migrations and initial Admin seed complete.');
  } else if (command === 'migrate') {
    await migrate(db);
    console.info('Migrations applied.');
  } else if (command === 'seed') {
    await seed(db);
    console.info('Initial seed complete.');
  } else if (command === 'samples') {
    const catalog = await loadSampleCatalog();
    if (process.argv.includes('--dry-run')) {
      console.info(
        JSON.stringify(
          {
            source: catalog.source,
            items: catalog.items.length,
            withPhotos: catalog.items.filter((item) => item.photos.length).length,
            sampleAvailableUnits: catalog.items.reduce(
              (sum, item) => sum + sampleAvailable(item),
              0,
            ),
            warnings: catalog.warnings,
          },
          null,
          2,
        ),
      );
    } else {
      await migrate(db);
      const [actor] = await db.query(
        "SELECT id FROM users WHERE role='Admin' AND enabled=true ORDER BY created_at,id LIMIT 1",
      );
      if (!actor) throw new Error('Create the initial Admin before importing samples.');
      const withStock =
        process.argv.includes('--with-stock') ||
        (!config.production && !process.argv.includes('--catalog-only'));
      console.info(JSON.stringify(await importSampleCatalog(db, actor.id, { withStock }), null, 2));
    }
  } else if (command === 'reconcile') {
    const discrepancies = await reconcile(db);
    console.info(JSON.stringify({ discrepancies }, null, 2));
    if (discrepancies.length) process.exitCode = 1;
  } else
    throw new Error(
      'Usage: cli [setup|migrate|seed|samples [--dry-run|--catalog-only|--with-stock]|reconcile]',
    );
} finally {
  await db.close();
}
