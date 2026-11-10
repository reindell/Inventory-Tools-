import { copyFile } from 'node:fs/promises';
await copyFile('server/image-worker.js', 'dist-server/image-worker.js');
