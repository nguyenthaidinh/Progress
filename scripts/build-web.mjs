// Export the hosted office with connection setup, explicit demo and auxiliary browser-log observation.
// The public build contains no PC backend or AI credentials and starts unpaired.
process.env.OFFICE_PUBLIC_WEB = '1';
await import('./build-demo.mjs');
