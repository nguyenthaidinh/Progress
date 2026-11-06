# LioOps branding

The original supplied logo lives at `public/assets/branding/Logo.png`. It was moved into the repository unchanged.

Run `npm run brand:assets` to rebuild the trimmed wordmark, compact emblem, browser/PWA icons and social sharing cards. The script preserves the source file and uses its transparent gap to separate the emblem for small icons.

The UI uses the full wordmark on desktop and the emblem on phones. The 3D lobby and exported images use the same assets. Add `NEXT_PUBLIC_BASE_PATH` when referencing these files in the static demo.

The app/package name is LioOps (`lioops`). The legacy `my-office` CLI alias, hook identifiers, environment variables and background-service identifiers remain compatible with existing installations.
