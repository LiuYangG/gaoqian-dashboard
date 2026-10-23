import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const snapshotFile = path.join(root, 'data', 'snapshot.json');

await fs.access(snapshotFile);
const snapshot = JSON.parse(await fs.readFile(snapshotFile, 'utf8'));

// Do not publish the MarsOJ account name in the public snapshot.
if (snapshot.source) delete snapshot.source.studentUser;

await fs.rm(dist, { recursive: true, force: true });
await fs.cp(path.join(root, 'public'), dist, { recursive: true });

await fs.writeFile(path.join(dist, 'data.json'), JSON.stringify(snapshot), 'utf8');
await fs.writeFile(
  path.join(dist, 'state.json'),
  JSON.stringify({
    hasData: true,
    static: true,
    generatedAt: snapshot.generatedAt,
    stats: snapshot.stats,
    running: false,
    progress: null,
    error: null,
    lastCheck: null,
    newHomeworks: [],
    autoCheck: false,
  }),
  'utf8',
);

let html = await fs.readFile(path.join(dist, 'index.html'), 'utf8');
html = html.replace(
  '<script src="./app.js"></script>',
  '<script>window.DASHBOARD_STATIC = true;</script>\n  <script src="./app.js"></script>',
);
await fs.writeFile(path.join(dist, 'index.html'), html, 'utf8');

await fs.writeFile(path.join(dist, '.nojekyll'), '');
await fs.writeFile(path.join(dist, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8');

console.log(`static build ready: ${dist}`);
console.log(`homeworks=${snapshot.homeworks?.length || 0} students=${snapshot.students?.length || 0} records=${snapshot.records?.length || 0}`);
