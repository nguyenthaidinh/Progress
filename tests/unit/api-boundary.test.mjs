import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

test('panels and React components use named operations instead of raw API URLs or network clients', () => {
  const violations = [];
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(file); continue; }
      if (!/\.(?:js|tsx)$/.test(entry.name)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JS);
      function visit(node) {
        const literal = ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ? node.head.text : '';
        if (literal.startsWith('/api/')) violations.push(`${file}:raw-api-url`);
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(ast);
          if (['fetch', 'sendBeacon', 'XMLHttpRequest', 'EventSource', 'WebSocket'].includes(name)) violations.push(`${file}:${name}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
  }
  scan('src/office/ui'); scan('src/components');
  assert.deepEqual(violations, []);
});
