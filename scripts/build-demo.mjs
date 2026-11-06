#!/usr/bin/env node
// Builds the online demo: a static site that plays the office's demo mode with no server behind it. English sits at
// the root and every other language in its own folder (/vi/). Output: demo-site/, ready for GitHub Pages or any static
// host.
//
//   node scripts/build-demo.mjs                                  # served from the root of a domain
//   OFFICE_BASE_PATH=/my-office node scripts/build-demo.mjs  # served from a GitHub Pages project path
//
// Each language is a separate `next build` with OFFICE_STATIC=1 (see next.config.mjs). A static export still writes
// its working files to .next, which is what a running office serves from, so the builds run in a copy of the page's
// sources under .demo-build/src (node_modules linked, Turbopack's root set to the repository).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS, DEFAULT_LANG } from '../src/i18n/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = process.env.OFFICE_PUBLIC_WEB === '1';
const SITE = path.join(ROOT, WEB ? 'web-site' : 'demo-site'), WORK = path.join(ROOT, WEB ? '.web-build' : '.demo-build', 'src');
const BASE = (process.env.OFFICE_BASE_PATH || '').replace(/\/+$/, '');
const SOURCES = ['app', 'src', 'public', 'package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json', 'next-env.d.ts'];

// Verify resolved targets before deleting old build output, including a pre-existing Windows junction.
for (const target of [SITE, path.dirname(WORK)]) {
  const resolved = fs.existsSync(target) ? fs.realpathSync(target) : path.resolve(target), relative = path.relative(fs.realpathSync(ROOT), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Build output must stay inside the repository');
  fs.rmSync(target, { recursive: true, force: true });
}
fs.mkdirSync(WORK, { recursive: true });
// The async copy path also avoids cpSync's native Windows failure on Unicode workspace paths.
for (const s of SOURCES) if (fs.existsSync(path.join(ROOT, s))) await fsp.cp(path.join(ROOT, s), path.join(WORK, s), { recursive: true });
fs.symlinkSync(process.platform === 'win32' ? path.join(ROOT, 'node_modules') : path.relative(WORK, path.join(ROOT, 'node_modules')), path.join(WORK, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

for (const lang of [DEFAULT_LANG, ...Object.keys(LANGS).filter((l) => l !== DEFAULT_LANG)]) {
  const sub = lang === DEFAULT_LANG ? '' : `/${lang}`, out = `out-${lang}`;
  console.log(`\n▶ ${LANGS[lang].name}: ${BASE + sub || '/'}`);
  execFileSync(process.execPath, [path.join(WORK, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], {
    cwd: WORK, stdio: 'inherit',
    env: {
      ...process.env, NEXT_TELEMETRY_DISABLED: '1',
      OFFICE_STATIC: '1', OFFICE_DEMO: WEB ? '0' : '1', OFFICE_STATIC_LANG: lang, OFFICE_SITE_ROOT: BASE, OFFICE_BASE_PATH: BASE + sub,
      OFFICE_DIST_DIR: out, OFFICE_TURBO_ROOT: ROOT,
      OFFICE_BUILD_WORKERS: process.env.OFFICE_BUILD_WORKERS || '2',
    },
  });
  await fsp.cp(path.join(WORK, out), path.join(SITE, sub), { recursive: true });
}
fs.writeFileSync(path.join(SITE, '.nojekyll'), '');   // GitHub Pages: serve the _next folder as is
console.log(`\n${WEB ? 'LioOps website' : 'Demo site'} in ${path.relative(process.cwd(), SITE) || '.'}/`);
