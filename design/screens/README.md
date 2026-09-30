# Screen captures

The AI captures these itself. Do not ask the user to take screenshots.
The built-in Claude browser only shows images and cannot save files, so use
Playwright to write the PNGs.

## How

1. Install once in a scratch folder (not in the project): `npm i playwright-core`.
   It drives the installed Google Chrome, so no browser download is needed.
2. Start a second dev server with the Supabase keys blanked, so the app uses its
   local mock user and no real data appears:
   `VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npx vite --port 5199`
3. The mock feed starts empty. Seed sample posts by setting the localStorage key
   `foundit:v1:items` (a JSON array of items) with an init script before the page loads.
4. Launch Chrome headless at 375x812, deviceScaleFactor 2, mobile and touch on.
5. Go to the landing page, click "Get started", then "Continue with Google" (mock).
6. Visit each screen below and save a PNG here as `NN-name.png`.
7. Re-capture only the screens changed by the current task.

## Screens

01-feed, 02-post-detail (found post), 03-composer, 05-i-found-it (lost post with the verification-form card), 08-alerts, 09-my-profile,
10-author-profile, 11-search, 12-landing, 13-gallery

## Rules

- 375x812, light theme, realistic sample data. No real personal data.
- Name files exactly as listed so other tools can find them.
- Stop the extra dev server when done.
