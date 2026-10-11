# AGENTS.md

## Project

**Informant** is a modern Inform 7 development environment built first as a Visual Studio Code extension.

Repository:
`https://github.com/interactivefiction/informant`

The project is a spiritual successor to Vimform7, not a port of the old GNOME Inform IDE.

## Primary goals

Keep the core workflow simple and dependable:

1. Create or open an Inform project.
2. Edit `Source/story.ni`.
3. Build using a private, known-good Inform toolchain.
4. Show build results.
5. Browse Inform documentation inside VS Code.
6. Add richer IDE integration only after the basic workflow is solid.

Do not redesign unrelated parts of the extension unless explicitly requested.

## Project philosophy

Informant must not make Inform projects dependent on Informant.

A project should remain a normal Inform project that can still be built or edited with other tooling if VS Code or Informant disappears.

Avoid:
- proprietary project formats that replace normal Inform structure
- world data stored only inside Informant
- build steps that cannot be reproduced outside the extension
- hidden dependency on a system-wide Inform installation

Prefer:
- normal `.inform` project structure
- private/versioned compiler tooling
- reproducible build behavior
- small, reviewable changes

## Current project baseline

The current proof-of-concept version is **0.1.4**.

Important existing behavior:
- project creation already works
- the Create Inform Project UI uses a Webview
- the extension has commands, output handling, and some toolchain discovery
- the existing build path still needs to be replaced with the proven modern compiler pipeline

Do not remove working behavior while implementing compiler integration.

## Known-good Inform toolchain

The proven source versions are:

- Inform 10.1.2
- Inweb 7.2.0
- Intest 2.1.0

The toolchain package produced by CI has this layout:

```text
PACKAGE/
├── Compilers/
│   ├── inform7
│   ├── inform6
│   └── inblorb
└── [contents copied from inform/inform7/Internal/]
```

Informant should recognize this layout directly.

The binaries are expected at:

```text
PACKAGE/Compilers/inform7
PACKAGE/Compilers/inform6
PACKAGE/Compilers/inblorb
```

The package root itself contains the Inform internal resources.

## Proven build pipeline

The known-good pipeline is:

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

The pipeline has already been validated outside VS Code on a large real project.

Do not invent a different compiler architecture unless explicitly requested.

## Current implementation order

Work in small milestones.

### Milestone 1 — toolchain discovery

Teach Informant to recognize the CI package layout:

```text
PACKAGE/Compilers/inform7
PACKAGE/Compilers/inform6
PACKAGE/Compilers/inblorb
```

Do not modify unrelated build behavior in the same change.

### Milestone 2 — compiler integration

Replace the generic one-command compile path with the proven Inform 10.1.2 pipeline.

Keep the implementation explicit and easy to debug.

### Milestone 3 — static documentation viewer

Add Inform documentation as a static Webview.

For the first documentation implementation:
- render the generated HTML cleanly
- make CSS/images/resources resolve correctly
- allow normal page navigation
- do **not** implement paste-code or create-project actions yet

## Documentation layout

Generated documentation behaves like a small website.

A working site-root layout includes:

```text
documentation-root/
├── book/
│   ├── RB_*.html
│   ├── WI_*.html
│   └── ...
└── assets/
    └── images/
        └── doc_images/
```

Pages may reference assets with root-relative URLs such as:

```text
/assets/images/doc_images/arrow-left.png
```

Opening a page through a server rooted at `documentation-root` renders correctly, for example:

```text
http://localhost:8000/book/RB_10_11.html
```

The VS Code Webview should emulate this site-root behavior by mapping/re-writing resources to Webview-safe URIs.

## Documentation host API — later work

Generated Inform documentation may contain JavaScript expecting:

```javascript
window.Project
```

Known methods include:

```text
selectView(...)
pasteCode(...)
createNewProject(...)
```

Do not implement this compatibility layer during the first static documentation milestone.

Later, it can be bridged to the VS Code extension using Webview messaging.

## Development style

When making changes:

- keep diffs small and reviewable
- preserve current working behavior
- avoid broad refactors unless requested
- do one architectural change at a time
- explain what files are being changed and why
- prefer explicit code over clever abstractions in the early stages
- do not silently introduce new dependencies
- do not switch the project to TypeScript or another framework unless explicitly requested

## Build and release workflow

GitHub is the canonical source repository.

GitHub Actions currently packages the extension into a `.vsix`.

The development loop is:

```text
edit locally
    ↓
review diff
    ↓
test
    ↓
commit/push
    ↓
GitHub Actions
    ↓
download/test VSIX
```

Marketplace publication is not the current goal.

## Long-term direction

Informant may later gain:
- richer compiler result/index tabs
- Inform IDE-style documentation actions
- play/interpreter integration
- Lantern AI integration
- a separate reusable platform-specific compiler/toolchain extension
- a possible minimal Vim-based fallback environment ("Vimformant")

Do not implement these prematurely.
