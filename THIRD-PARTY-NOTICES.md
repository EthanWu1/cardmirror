# Third-Party Notices

CardMirror incorporates the following third-party materials. Each is
used under its own license, reproduced or summarized below. This file
satisfies the attribution / notice obligations of those licenses; it
does not modify the terms under which CardMirror itself is offered (see
[`LICENSE`](./LICENSE)).

---

## Bundled JavaScript libraries (MIT)

CardMirror bundles the following libraries into its shipped code (the web
build, the PWA, and the Electron renderer / main process). Because they
are compiled into the application bundle rather than distributed as
`node_modules/`, their required copyright and permission notices are
reproduced here. All are used under the **MIT License**, the text of
which appears once below.

Editor / renderer (web + Electron):

| Library | Copyright | Role |
| --- | --- | --- |
| [ProseMirror](https://prosemirror.net/) (`prosemirror-model`, `-state`, `-view`, `-transform`, `-commands`, `-keymap`, `-history`, `-tables`) | © 2015–2017 Marijn Haverbeke and others | Rich-text editing core |
| [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) | © 2017 Amit Kumar Gupta | `.docx` (OOXML) parsing |
| [fflate](https://github.com/101arrowz/fflate) | © Arjun Barrett | zip / gzip codec for `.cmir` and `.docx` |
| [nspell](https://github.com/wooorm/nspell) | © 2016 Titus Wormer | Hunspell-in-JS spellcheck engine |
| [tinyld](https://github.com/komodojp/tinyld) | © 2021 Komodo | Source-language detection for the Translator |

Electron main process (packaged desktop app):

| Library | Copyright | Role |
| --- | --- | --- |
| [electron-updater](https://github.com/electron-userland/electron-builder) | © 2015 Loopline Systems | Auto-update |
| [koffi](https://koffi.dev/) | © Niels Martignène | FFI to `libvosk` for voice recognition |

### MIT License

> Permission is hereby granted, free of charge, to any person obtaining a
> copy of this software and associated documentation files (the
> "Software"), to deal in the Software without restriction, including
> without limitation the rights to use, copy, modify, merge, publish,
> distribute, sublicense, and/or sell copies of the Software, and to
> permit persons to whom the Software is furnished to do so, subject to
> the following conditions:
>
> The above copyright notice and this permission notice shall be included
> in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
> OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
> MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
> IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
> CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
> TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
> SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

## Bundled fonts

The application bundles latin-subset webfonts (readability faces and
metric-compatible substitutes for proprietary/system fonts the font
picker offers). These are used under the **SIL Open Font License 1.1**,
the **Apache License 2.0**, and the **DejaVu / Bitstream Vera license**,
per family. Full per-family attribution, "Reserved Font Names", and
license texts are in [`src/editor/fonts/LICENSES.md`](./src/editor/fonts/LICENSES.md).

---

## English spellcheck dictionary

The optional in-editor spellchecker (loaded only when spellcheck is
enabled) reads a bundled English Hunspell dictionary
(`src/editor/dict/en.aff` + `en.dic`) through nspell. Standard en-US
Hunspell dictionaries derive from the **SCOWL** word lists by Kevin
Atkinson and are freely redistributable. (The specific `.aff`/`.dic`
were vendored from an upstream Hunspell English dictionary; see the
project maintainer to confirm the exact source distribution.)

---

## Voice recognition (Vosk)

The optional voice-control feature uses **Vosk** by Alpha Cephei:
`libvosk` (bundled with the desktop app) and the recognition models
(`vosk-model-en-us-0.22-lgraph` and, optionally, `vosk-model-en-us-0.22`),
which are **downloaded at runtime into the user's data directory** rather
than shipped in the installer. Vosk and its published models are used
under the **Apache License 2.0**
(<https://github.com/alphacep/vosk-api>). The Apache 2.0 license text is
in [`src/editor/fonts/Apache-2.0.txt`](./src/editor/fonts/Apache-2.0.txt)
(the same license the Arimo font family uses).

---

## Untitled UI Icons

The application's interface icons (toolbar, banners, dialogs, status
bar) are from the [Untitled UI free icons](https://www.untitledui.com/free-icons),
© 2025 Untitled UI. They are obtained from the community packaging at
<https://github.com/untitleduico/icons>.

The icons are used under the **Untitled UI free license**. Per that
license:

> **You are allowed to:**
> - Use the icons in personal and commercial projects.
>
> **You are not allowed to:**
> - Sell, sublicense, or distribute the icons (in original or modified form).
> - Create derivative icon libraries based on the icons.
> - Use the icons in any form of UI kit, library, or template intended for resale.

The full agreement is at <https://www.untitledui.com/license>.

In CardMirror the icons are used as product UI. The upstream `.svg`
files and the icon set as a whole are not committed or redistributed:
the full set lives only in a developer's gitignored local clone.
`scripts/gen-icons.mjs` bakes the specific glyphs the app uses into
`src/editor/icons.css` as `currentColor` mask images (so that single
generated file does embed those glyphs' path data), and the shipped
application renders from it. The icons are not repackaged as an icon
library or offered for resale.
