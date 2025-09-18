const fs = require('fs');
const path = require('path');

const buildPath = path.join(__dirname, '..', 'static', 'hello-world', 'build', 'create.html');

try {
  const content = fs.readFileSync(buildPath, 'utf8');

  const checks = [
    { name: 'pageObj usage', ok: /const\s+pageObj\s*=\s*\(j\s*&&\s*j.page\)\s*\?\s*j.page\s*:\s*j/.test(content) },
    { name: 'webui extraction', ok: /const\s+webui\s*=\s*pageObj\s*&&\s*\(pageObj.webui\s*\|\|\s*\(pageObj._links\s*&&\s*pageObj._links.webui\)\)/.test(content) },
    { name: 'redirect if webui', ok: /if\s*\(webui\)\s*\{[\s\S]*location.replace\(/.test(content) },
    { name: 'fallback pageId link', ok: /if\s*\(pageId\)\s*\{[\s\S]*Open page/.test(content) },
  ];

  const failed = checks.filter(c => !c.ok);

  if (failed.length === 0) {
    console.log('SMOKE PASS: create.html contains expected redirect logic.');
    process.exit(0);
  } else {
    console.error('SMOKE FAIL: create.html missing expected snippets:');
    failed.forEach(f => console.error('- ' + f.name));
    process.exit(2);
  }
} catch (err) {
  console.error('SMOKE ERROR: could not read build create.html', err.message);
  process.exit(3);
}
