# Informant Architecture Notes

## 1. Purpose

Informant is intended to provide a modern, dependable Inform 7 development environment without repeating the dependency fragility of older Linux Inform IDEs.

The initial implementation target is a Visual Studio Code extension.

The long-term UX is:

```text
Create → Edit → Build → Play
```

The editor should hide compiler/toolchain complexity while preserving normal Inform project structure.

## 2. Historical motivation

Informant is philosophically descended more directly from **Vimform7** than from the old GNOME Inform IDE.

The important lesson from the older Linux IDE ecosystem was that a writing environment should not become unusable because a GUI dependency disappears from the operating system.

Older GNOME Inform builds depended on legacy components including WebKitGTK 1.0, GooCanvas, and Chimara. Preserving those dependencies was possible, but it demonstrated why the next-generation workflow should isolate the essential Inform machinery from the host desktop environment.

Vimform7 reduced the required stack to the essentials:
- editor
- compiler pipeline
- documentation
- build/run support

Informant keeps that same reliability philosophy while providing a modern GUI inside VS Code.

## 3. Core design principle

**An Informant project should remain an Inform project.**

If VS Code or Informant vanished, the source tree should still be understandable and buildable by other Inform tooling.

Therefore Informant should avoid:
- proprietary source formats
- hidden canonical world state
- compiler transformations that exist only inside the extension
- assumptions about system-wide Inform installations

## 4. Project structure

Informant currently creates conventional `.inform` projects with a structure including:

```text
My Story.inform/
├── Source/
│   └── story.ni
├── Materials/
├── Extensions/
└── .informant.json
```

`story.ni` remains the canonical source.

## 5. Toolchain architecture

Known-good source versions:

```text
Inform  10.1.2
Inweb    7.2.0
Intest   2.1.0
```

Toolchain source repositories use versioned branches.

A separate repository produces known-good packaged toolchains through GitHub Actions.

The proven package assembly is:

```text
PACKAGE/
├── Compilers/
│   ├── inform7
│   ├── inform6
│   └── inblorb
└── [Inform Internal resources]
```

The Internal tree is copied from:

```text
inform/inform7/Internal/
```

The key idea is that the packaged toolchain is the durable product boundary.

Informant consumes that package rather than depending on a distro installation.

This also leaves open a later clean split where a platform-specific "Inform 7 Toolchain" VS Code extension contains the binaries and Informant depends on it.

For now, the practical plan is to make Informant work first, including the required toolchain, and split packaging later only if useful.

## 6. Proven compiler pipeline

The modern compiler chain is:

```text
.inform project
    ↓
inform7
    ↓
Build/auto.inf
    ↓
inform6
    ↓
Build/output.ulx
    ↓
inblorb
    ↓
Build/output.gblorb
```

This replaces older Vimform7-era assumptions:

```text
ni      → inform7
CBlorb  → inblorb
inform6 → inform6
```

A large real project was successfully compiled with the packaged toolchain.

The final generated ULX was byte-for-byte identical to output produced by the official IDE, including identical `auto.inf`.

That establishes the new toolchain as a trustworthy build foundation.

## 7. CI and reproducibility

The toolchain CI builds Inweb, Intest, and Inform from source, runs tests, assembles the package, and uploads the archive.

The Informant repository has its own GitHub Action that packages the extension into a VSIX.

This gives two independent build products:

```text
toolchain repositories
        ↓
versioned compiler package

informant repository
        ↓
VSIX extension
```

Longer term these can be combined cleanly without coupling source histories.

## 8. Documentation generation

Inform documentation is generated from source using **Indoc**.

The documentation source is under:

```text
inform/resources/Documentation/
```

The generator is:

```text
indoc
```

So the actual documentation pipeline is:

```text
Indoc source
    ↓
indoc
    ↓
HTML/CSS/images
    ↓
IDE or browser presentation
```

This is preferable to relying on copies extracted from an installed IDE.

## 9. Documentation site-root behavior

Generated documentation is not meant to be treated as isolated HTML files.

It behaves like a small website with a shared root.

A representative layout is:

```text
documentation-root/
├── book/
│   ├── RB_6_4.html
│   ├── RB_10_11.html
│   ├── WI_*.html
│   └── ...
└── assets/
    └── images/
        └── doc_images/
            ├── arrow-left.png
            ├── arrow-right.png
            ├── arrow-up.png
            └── ...
```

Pages can use root-relative references such as:

```html
<img src="/assets/images/doc_images/arrow-right.png">
```

A normal browser renders the pages correctly when the parent directory is served as the web root, e.g.:

```text
http://localhost:8000/book/RB_10_11.html
```

This is the important model for Informant's Webview implementation.

## 10. VS Code documentation Webview

The first documentation milestone should be intentionally static.

Required behavior:

```text
generated docs tree
       ↓
Informant Webview
       ↓
clean HTML rendering
       ↓
normal links/navigation
```

The extension needs to:
- load requested documentation HTML
- resolve CSS and images
- map root-relative `/assets/...` references
- convert local resources to Webview-safe URIs
- allow links between documentation pages

It does **not** initially need to emulate the full Inform IDE.

## 11. Inform documentation application bridge

Some generated documentation assumes it is running inside an Inform application.

Example page-side JavaScript:

```javascript
function pasteCode(code) {
    var myProject = window.Project;

    myProject.selectView('source');
    myProject.pasteCode(code);
}
```

and:

```javascript
function createNewProject(code, title) {
    var myProject = window.Project;

    myProject.createNewProject(title, code);
}
```

This reveals an application-facing API through:

```text
window.Project
```

Known calls include:

```text
selectView(...)
pasteCode(...)
createNewProject(...)
```

These behaviors are future enhancements.

In VS Code they can later be emulated with a small JavaScript compatibility shim:

```text
generated HTML
      ↓
window.Project shim
      ↓
webview.postMessage(...)
      ↓
Informant extension command
```

This is not required for the first static docs implementation.

## 12. `inform:` URI handling

The official Inform IDE registers a custom `inform:` URI scheme for documentation/resources.

Historically, similar behavior was implemented in a Qt WebEngine experiment using `QWebEngineUrlSchemeHandler`.

For Informant, VS Code Webviews do not require reproducing a native browser scheme exactly.

Instead, Informant can:
- resolve document/resource paths itself
- map local files through `webview.asWebviewUri(...)`
- intercept application-specific navigation or actions where necessary

## 13. Current implementation roadmap

### Stage A — stabilize extension packaging

Status: working.

The repository builds a VSIX via GitHub Actions.

### Stage B — toolchain discovery

Update the extension so it recognizes the real package layout:

```text
PACKAGE/Compilers/inform7
PACKAGE/Compilers/inform6
PACKAGE/Compilers/inblorb
```

### Stage C — compiler integration

Replace the generic build command with the proven multi-stage pipeline.

Success criterion:
- compile a normal Inform project from inside VS Code
- ultimately compile the large Cromagnon project successfully

### Stage D — static docs

Render generated Inform documentation inside a Webview.

No paste/create-project bridge yet.

### Stage E — richer HTML/IDE compatibility

Add selected `window.Project` behavior and other useful Inform IDE actions only after static rendering is reliable.

### Stage F — play integration

Add story execution/interpreter support.

### Stage G — Lantern integration

Lantern is a future AI participant/player layer.

Inform remains authoritative for canonical game-world state.

Lantern may later provide:
- conversational character interaction
- generated presentation
- images
- maps
- audio
- other AI-assisted experiences

Do not mix Lantern into the compiler/documentation work prematurely.

## 14. Possible future toolchain split

A clean future architecture could be:

```text
GitHub Actions toolchain builds
        ↓
platform-specific toolchain package
        ↓
Inform 7 Toolchain VS Code extension
        ↓
Informant
```

Advantages:
- Informant can stay largely platform-independent
- other VS Code extensions can reuse the same compiler package
- compiler updates can be versioned separately from IDE behavior

This is a future refinement, not a current requirement.

## 15. Vimformant contingency concept

A minimal Vim-based fallback environment may eventually consume the same CI-generated toolchain packages.

Its purpose would be resilience, not feature parity.

Potential minimal feature set:

```text
editor
build
documentation
run
```

For terminal documentation, a derived Lynx-friendly HTML tree could remove or rewrite decorative image controls.

This concept is intentionally parked until Informant is working.

## 16. Engineering guidance

During current development:

- prefer incremental changes
- avoid speculative refactoring
- keep the existing project creator working
- use the proven compiler package rather than rebuilding compiler logic
- make static documentation work before implementing interactive documentation APIs
- keep Inform project files portable
- keep build failures observable through logs/output
- favor reproducibility over convenience magic

The project should remain understandable to someone debugging it years later.
