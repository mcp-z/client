// Stand-in browser: appends the one URL argument it was given to <dir>/received.log.
import { appendFileSync } from 'fs';
import { join } from 'path';

appendFileSync(join(process.argv[2], 'received.log'), `${process.argv[3]}\n`);
