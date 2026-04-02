# staylocal.github.io

Landing page for **StayLocal** — a cross-platform local WiFi file transfer app.

Hosted at: https://vijay8059.github.io/staylocal.github.io (or configure a custom domain)

## Binary hosting

Binaries are attached as release assets to the [staylocal](https://github.com/vijay8059/staylocal) app repo.

Expected release asset names (referenced in `index.html`):
```
staylocal-macos-arm64.dmg
staylocal-macos-x86_64.dmg
staylocal-windows-x86_64.exe
staylocal-windows-x86_64.msi
staylocal-linux-x86_64.tar.gz
staylocal-linux-arm64.tar.gz
```

Upload these when you tag a release (`git tag v0.1.0 && git push --tags`) and GitHub Actions (or manual upload) attaches them to the release. Download links in the landing page use the `/releases/latest/download/` URL pattern so they always point to the newest release automatically.

## GitHub Pages setup

1. Go to **Settings → Pages** in this repo
2. Set source to `main` branch, root `/`
3. Optionally add a custom domain
