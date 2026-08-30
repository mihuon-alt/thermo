# ThermoCell Vision — PWA/Web Build

This build runs the visual heat-estimation pipeline directly in the browser:
camera input -> OpenCV.js/WASM -> hot-region + placement overlay.

## Camera permission fix

The app now distinguishes:

- **Prompt**: the browser has not decided yet; `ALLOW CAMERA` calls `getUserMedia()`.
- **Granted**: the app starts the camera.
- **Denied**: the app explains how to change the browser/site permission instead of
  pretending that JavaScript can force a new prompt.
- **Embedded preview**: the app detects iframe/Codespaces-style previews and tells
  you to open the normal HTTPS page in a top-level browser tab.

This matters because browsers can reject `getUserMedia()` without showing a new
prompt after a site-level denial, and camera access is restricted to secure
contexts. GitHub Pages provides HTTPS.

## GitHub Pages deployment

Publish the **contents of `web/` as the Pages site root** so these URLs resolve:

```text
https://YOUR-USER.github.io/YOUR-REPO/
├── index.html
├── app.js
├── heat_detector.js
├── temporal_smoother.js
├── style.css
├── manifest.json
├── sw.js
├── icon-192.png
└── icon-512.png
```

Use an HTTPS GitHub Pages URL. Do not test camera access from an ordinary
HTTP LAN URL.

## First camera test

1. Open the GitHub Pages URL directly in Chrome/Edge/Safari/Firefox.
2. If the page says it is embedded, use **OPEN IN NORMAL TAB**.
3. Tap **ALLOW CAMERA**.
4. Accept the browser's camera prompt.
5. If the browser says permission is blocked, use the site controls next to
   the address bar -> Site settings -> Camera -> Allow, return to the page,
   then tap **CHECK AGAIN**.

A web page cannot universally reset a browser-level camera denial itself.

## PWA

`manifest.json` now includes a stable `id`, `start_url`, `scope`, installable
display modes, and maskable icons. `sw.js` caches the local app shell and
runtime-caches the OpenCV.js resources when they are successfully fetched.

## Local development

```bash
cd web
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

`localhost` is an allowed secure context for camera APIs in supporting browsers.

## Files

```text
web/
  index.html
  style.css
  app.js
  heat_detector.js
  temporal_smoother.js
  manifest.json
  sw.js
  icon-192.png
  icon-512.png
```
