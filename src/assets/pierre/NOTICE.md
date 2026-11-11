# Pierre icon subset

Selected SVGs copied unchanged from the published packages:

- `Icon*.svg`: `@pierre/icons` 0.9.0, The Pierre Computer Company. Apache-2.0; see `LICENSE-icons`.
- Other SVGs: `@pierre/vscode-icons` 0.0.9, The Pierre Computer Company. MIT; see `LICENSE-vscode-icons.md`.

`src/icons.ts` changes the toolbar icons' black fills to `currentColor` when rendering so they follow the app theme. Assets are bundled locally. No React dependency is needed. These are UI/file icons; the Windows executable/installer icon is unchanged.
