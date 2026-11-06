// Next.js renders the page shell and bundles the office's code (Turbopack, in development and for builds).
// The server in front of it (server/index.mjs) handles the hooks, the live stream and the API.
//
// Static rendering is independent of the data source. The legacy demo build explicitly sets OFFICE_DEMO=1;
// public exports start unpaired and only use sample data after the viewer selects ?demo.
const STATIC = process.env.OFFICE_STATIC === '1';

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,   // the office fills the screen; compile and runtime errors still show
  poweredByHeader: false,
  ...(process.env.OFFICE_BUILD_WORKERS && { experimental: { cpus: Math.max(1, Math.min(8, Number(process.env.OFFICE_BUILD_WORKERS) || 2)) } }),
  // OFFICE_DIST_DIR also for the office itself: a build for tests (e.g. .next-e2e, with the same variable for
  // `playwright test`) leaves the .next the running office serves alone; replacing that under it breaks its pages
  ...(!STATIC && process.env.OFFICE_DIST_DIR && { distDir: process.env.OFFICE_DIST_DIR }),
  ...(STATIC && {
    output: 'export',
    basePath: process.env.OFFICE_BASE_PATH || '',
    distDir: process.env.OFFICE_DIST_DIR || 'out',
    trailingSlash: true,
    // scripts/build-demo.mjs builds from a copy inside the repo (so the live .next is left alone): resolve from the repo
    ...(process.env.OFFICE_TURBO_ROOT && { turbopack: { root: process.env.OFFICE_TURBO_ROOT } }),
  }),
  env: {
    NEXT_PUBLIC_OFFICE_STATIC: STATIC ? '1' : '',
    NEXT_PUBLIC_OFFICE_WEB: process.env.OFFICE_PUBLIC_WEB === '1' ? '1' : '',
    NEXT_PUBLIC_OFFICE_SOURCE: process.env.OFFICE_DEMO === '1' ? 'demo' : STATIC || process.env.OFFICE_PUBLIC_WEB === '1' ? 'unpaired' : 'local-http',
    NEXT_PUBLIC_BASE_PATH: STATIC ? process.env.OFFICE_BASE_PATH || '' : '',
    // the demo site's root, where English lives; other languages are folders under it
    NEXT_PUBLIC_SITE_ROOT: STATIC ? process.env.OFFICE_SITE_ROOT || '' : '',
  },
};

export default nextConfig;
