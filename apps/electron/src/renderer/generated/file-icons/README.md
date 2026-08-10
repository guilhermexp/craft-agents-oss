# Material Icon Theme assets

Vendored from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme)
by Philipp Kief, MIT licensed.

Served as public assets, not bundled modules: a tree shows a handful of these
at a time, and 1080 inlined components would ship in every renderer chunk.

`./manifest.json` maps filenames, extensions and
folder names onto the vendored SVGs in `../../public/file-icons`. It is pruned so every name it can return has an
asset here — a mapping without a file renders a broken image, while a dropped
mapping falls back to `file.svg` / `folder.svg`.
