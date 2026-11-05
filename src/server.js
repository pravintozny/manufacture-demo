import { createApp } from './app.js';
import { createServer } from './http.js';
import { seed } from './seed.js';

const port = Number(process.env.PORT ?? 3000);
const app = createApp({ file: process.env.DATA_FILE || null });
if (process.env.SEED === '1' && app.store.list('products').length === 0) seed(app);
createServer(app).listen(port, () => console.log(`manufacture-demo listening on :${port}`));
