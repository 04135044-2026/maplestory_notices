import { website } from './site.mjs';

const port = Number(process.env.PORT ?? 3181);
website({ enableSchedule: true }).listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:' + port));
