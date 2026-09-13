# Informant Architecture and Compatibility Notes

## 1. Purpose

**Informant** is a modern development environment for Inform 7,
initially implemented as a Visual Studio Code extension.

The intended workflow is:

``` text
Create → Edit → Build → Play
```

Informant should make the compiler and toolchain straightforward to use
while preserving normal Inform project structure and interoperability
with the wider Inform ecosystem.

This document records both the architectural direction of Informant and
practical compatibility details established during development. It is
intended for contributors, future maintainers, and anyone interested in
building tooling around Inform.

Informant builds on the work of the Inform project, its IDEs, and
earlier community tooling. Where Informant makes a different
implementation choice, that should be understood as a design choice for
this project rather than a criticism of another implementation.

## 2. Design lineage

Informant draws useful ideas from both the contemporary Inform
development environment and earlier tooling.

**Vimform7** is an especially useful historical reference because it
demonstrated that a small environment can provide the essential Inform
workflow:

-   editing;
-   compiler integration;
-   documentation;
-   build and run support.

Informant carries forward that emphasis on a small, understandable
integration layer while providing a modern GUI through VS Code.

The current Inform IDE remains an important compatibility and behavior
reference, particularly when determining contemporary project
conventions and documentation behavior.

## 3. Core design principle

**An Informant project should remain an Inform project.**

If VS Code or Informant were unavailable, the source tree should still
be understandable and usable by other compatible Inform tooling.

Informant should therefore avoid:

-   proprietary source formats replacing normal Inform source;
-   hidden canonical world state stored only by Informant;
-   compiler transformations that cannot be reproduced independently;
-   unnecessary assumptions about a system-wide Inform installation.

`Source/story.ni` remains the canonical story source.

Informant-specific state should be kept separate and minimal.

## 4. Minimum project contract

Development testing has established the intended initial structure for a
newly created Informant story:

``` text
MyProject.inform/
├── Source/
│   └── story.ni
├── uuid.txt
└── .informant.json
```

`Source/story.ni` contains the Inform source.

`.informant.json` contains Informant-specific project metadata, such as
project type and selected toolchain information.

`uuid.txt` contains the story identifier required by the Inform build
process.

Informant should not pre-create generated directories merely to
reproduce the working state of another IDE.

## 5. Comparison with complete IDE project state

A newly created project from the contemporary Inform IDE may contain
additional files and directories such as:

``` text
Project.inform/
├── Build/
├── Index/
├── Source/
│   └── story.ni
├── Skein.skein
├── notes.rtf
└── Settings.plist
```

These support the complete IDE experience, including build state,
indexes, notes, settings, and skein information.

Earlier Vimform7 tooling demonstrated that a considerably smaller
project can participate successfully in the Inform toolchain.

Informant uses both forms as references while defining a deliberately
small project contract. It does not need to reproduce IDE session/state
files unless a future Informant feature specifically requires them.

## 6. Generated project material

`Build/` and `Index/` are generated during Inform processing and do not
need to exist when Informant initially creates a project.

Likewise, materials should follow Inform's established project
conventions. Informant should not create an arbitrary `Materials/`
directory inside the `.inform` project simply as initial scaffolding.

The project creator should create only persistent material that is
genuinely required before compilation.

## 7. `uuid.txt` compatibility requirement

`uuid.txt` is part of the minimum valid project contract.

A valid example is:

``` text
16358557-fb4e-46ca-975d-63c389a7c986
```

The contemporary Inform IDE has been observed generating a version 4
UUID. Informant can generate the identifier with Node.js's built-in:

``` javascript
crypto.randomUUID()
```

No external UUID dependency is required.

### Important: no trailing newline

`uuid.txt` must contain the UUID characters only.

Informant should write:

``` javascript
await vscode.workspace.fs.writeFile(
    uuidUri,
    Buffer.from(crypto.randomUUID(), 'utf8')
);
```

It should **not** append a newline.

Testing established that a trailing newline can propagate into generated
`Release.blurb` content. The IFID placeholder can then become split
across two lines, causing `inblorb` to reject the generated blurb.

For example, the resulting error can appear as:

``` text
Release.blurb, line 21: Error: not a valid blurb command
Release.blurb, line 22: Error: not a valid blurb command
```

This is easy to overlook because many text-writing tools conventionally
terminate text files with a newline and the UUID appears visually
correct in an editor.

The project-format rule is therefore:

``` text
uuid.txt = UUID only, with no trailing whitespace
```

A source comment should preserve this non-obvious requirement:

``` javascript
// Inform consumes uuid.txt without trimming trailing whitespace.
// Do not append a newline: it can propagate into Release.blurb
// and make the generated IFID invalid for inblorb.
```

## 8. Known-good toolchain versions

The current known-good source versions used by Informant development
are:

``` text
Inform  10.1.2
Inweb    7.2.0
Intest   2.1.0
```

Versioned source branches are used so that the build can be reproduced.

The current toolchain work uses:

``` text
interactivefiction/inweb   branch inweb-7.2.0
interactivefiction/intest  branch intest-2.1.0
interactivefiction/inform  branch inform-10.1.2
```

These pins describe the currently validated toolchain, not a permanent
restriction on future Informant versions.

## 9. Toolchain package architecture

A separate build process produces a known-good packaged toolchain.

The proven package layout is:

``` text
PACKAGE/
├── Compilers/
│   ├── inform7
│   ├── inform6
│   └── inblorb
└── [Inform Internal resources]
```

The Internal resource tree is copied from:

``` text
inform/inform7/Internal/
```

The distinction between the package root and compiler directory is
important:

``` text
PACKAGE/                  ← Inform internal environment
PACKAGE/Compilers/        ← executable compiler programs
```

`inform7` receives the package root through its `-internal` argument.

The package is therefore a useful durable boundary between the Inform
source build and applications that consume the compiler.

Informant's toolchain discovery recognizes the `Compilers/` layout.

## 10. Toolchain isolation

Informant should prefer its selected/versioned toolchain rather than
depending implicitly on whatever Inform executables happen to be
installed on the operating system.

This supports:

-   reproducible builds;
-   side-by-side toolchain versions;
-   reduced PATH ambiguity;
-   independence from distribution packaging choices;
-   easier testing and support.

System-installed tools may remain useful as an explicit fallback, but
they should not silently replace the selected Informant toolchain.

## 11. Compiler evolution relevant to Informant

Earlier workflows may refer to older executable names.

For the currently validated toolchain, the practical mapping is:

``` text
Earlier workflow    Current tool
---------------------------------
ni                  inform7
inform6             inform6
cBlorb              inblorb
```

This mapping is useful when consulting older scripts or Vimform7
material.

## 12. Proven compiler pipeline

The build sequence currently being integrated into Informant has already
been exercised successfully outside the extension:

``` text
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

### Stage 1 --- Inform 7

The known working form is:

``` text
<Compilers>/inform7 -internal <toolchain-root> -format=ulx -project "<project>" -release
```

This produces intermediate material including:

``` text
<project>/Build/auto.inf
```

### Stage 2 --- Inform 6

The known working form is based on:

``` text
<Compilers>/inform6 -wxE2~S~DG <huge-option> "<project>/Build/auto.inf" "<project>/Build/output.ulx"
```

The exact handling of the established `huge` option should be carried
forward from the proven build configuration rather than guessed.

This produces:

``` text
<project>/Build/output.ulx
```

### Stage 3 --- Inblorb

The known working form is:

``` text
<Compilers>/inblorb "<project>/Release.blurb" "<project>/Build/output.gblorb"
```

This produces:

``` text
<project>/Build/output.gblorb
```

## 13. Build implementation philosophy

Informant should execute the compiler stages directly rather than
requiring Make as part of the extension runtime.

Direct execution allows Informant to:

-   identify the active compiler stage;
-   capture stdout and stderr for each stage;
-   stop immediately when a stage fails;
-   translate compiler messages into VS Code diagnostics;
-   use the selected toolchain paths directly;
-   avoid adding Make as a runtime dependency.

A Makefile remains useful for development, testing, documentation, and
independent command-line workflows. It simply should not be required by
the Informant Build command.

## 14. Project, toolchain, and build responsibilities

Keeping responsibilities distinct makes the architecture easier to
reason about.

The project supplies persistent source and identity:

``` text
Project.inform/
├── Source/story.ni
├── uuid.txt
└── optional Informant metadata
```

The selected toolchain supplies:

``` text
inform7
inform6
inblorb
Inform Internal resources
```

The build process produces generated artifacts such as:

``` text
Build/
Index/
Release.blurb
Build/auto.inf
Build/output.ulx
Build/output.gblorb
```

Generated build state should not become part of Informant's required
source-project format.

## 15. Reproducibility validation

The packaged toolchain has been tested against a substantial existing
Inform project, **Cromagnon**.

The validation compared output from the established Inform environment
with output from the independently packaged Informant toolchain.

The resulting ULX files had the same SHA-256 digest:

``` text
d78df625c08a4f79e6581a5a0c94206ed5f936ff9da47e434d958dba22f52539
```

The generated `auto.inf` was also identical.

This byte-for-byte result provides strong evidence that the packaged
toolchain reproduces the expected story compilation result.

A small difference was observed in an Inform 6 working-memory report
between environments, but it did not alter the generated story output.

This validation is an important baseline for future compiler integration
work inside Informant.

## 16. Continuous integration architecture

The toolchain and Informant extension are built independently.

Conceptually:

``` text
Inweb + Intest + Inform source
            ↓
     toolchain CI
            ↓
versioned compiler package


Informant source
      ↓
 Informant CI
      ↓
 VSIX extension
```

The toolchain CI:

-   builds Inweb;
-   builds Intest;
-   builds Inform;
-   exercises Inblorb;
-   runs Inform tests;
-   assembles the deployment package;
-   archives the resulting platform toolchain.

The Informant repository CI packages the extension as a `.vsix`.

Keeping these concerns separate allows compiler/toolchain work and
editor work to evolve without unnecessarily coupling their source
histories.

## 17. Compatibility methodology

When expected behavior is unclear, Informant development uses several
complementary references:

1.  Projects created by the current Inform IDE show contemporary IDE
    conventions and complete project state.
2.  Inform source and compiler behavior establish the underlying
    toolchain contract.
3.  Vimform7 provides a historical reference for a small independently
    implemented Inform workflow and preserves useful practical
    compatibility knowledge.
4.  Actual compilation tests establish which assumptions hold for the
    packaged Inform version used by Informant.

No single reference needs to dictate Informant's complete design.

The objective is to identify the smallest dependable contract that
interoperates well with Inform.

## 18. Documentation generation

Inform documentation is generated from source using **Indoc**.

The documentation source is under:

``` text
inform/resources/Documentation/
```

The generator is:

``` text
indoc
```

The documentation pipeline is therefore:

``` text
Indoc source
    ↓
indoc
    ↓
HTML/CSS/images
    ↓
IDE or browser presentation
```

Generating documentation from its source is preferable for Informant to
depending on a copy extracted from an installed IDE.

## 19. Documentation site-root behavior

Generated Inform documentation behaves like a small website rather than
a collection of unrelated HTML files.

A representative layout is:

``` text
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

``` html
<img src="/assets/images/doc_images/arrow-right.png">
```

Testing showed that the pages render correctly when their parent
documentation directory is treated as the web root, for example:

``` text
http://localhost:8000/book/RB_10_11.html
```

This site-root relationship is the important model for Informant's
Webview implementation.

## 20. Static documentation Webview

The first documentation milestone should intentionally be static.

The initial goal is:

``` text
generated docs tree
       ↓
Informant Webview
       ↓
clean HTML rendering
       ↓
normal links/navigation
```

The extension will need to:

-   load requested documentation HTML;
-   resolve CSS and images;
-   map root-relative `/assets/...` references;
-   convert local resources to Webview-safe URIs;
-   support navigation among documentation pages.

It does not initially need to emulate every feature of the full Inform
IDE.

## 21. Documentation application bridge

Some generated Inform documentation contains JavaScript expecting a
host-provided object:

``` javascript
window.Project
```

Observed operations include:

``` text
selectView(...)
pasteCode(...)
createNewProject(...)
```

For example, generated documentation may contain logic conceptually
like:

``` javascript
function pasteCode(code) {
    var myProject = window.Project;
    myProject.selectView('source');
    myProject.pasteCode(code);
}
```

A future Informant compatibility bridge can map these operations to VS
Code Webview messages:

``` text
generated HTML
      ↓
window.Project compatibility shim
      ↓
webview.postMessage(...)
      ↓
Informant extension command
```

This behavior is intentionally deferred until static documentation
rendering is reliable.

## 22. `inform:` URI behavior

The current Inform IDE uses a custom `inform:` URI scheme for
documentation and related resources.

Earlier experimental Qt-based tooling also demonstrated a similar
host-side scheme-handler approach.

Informant does not need to reproduce a native browser URI scheme
literally.

A VS Code Webview can instead:

-   resolve documentation paths inside the extension;
-   translate local resources through `webview.asWebviewUri(...)`;
-   rewrite or intercept special links where appropriate;
-   map future host actions through Webview messaging.

The important requirement is compatibility of behavior, not duplication
of a particular browser embedding implementation.

## 23. Webviews as an architectural component

Webviews are expected to be an important part of Informant because
Inform produces and uses substantial HTML-based output.

Potential Webview uses include:

-   Inform documentation;
-   compiler-generated indexes;
-   object/world information;
-   skein-related presentation;
-   other HTML build artifacts.

Informant should reuse a consistent resource-resolution and navigation
strategy where practical rather than creating unrelated HTML handling
for each feature.

## 24. Current implementation roadmap

### Stage A --- extension packaging

**Status: working.**

The Informant repository can produce a VSIX through GitHub Actions and
through local VSCE packaging.

### Stage B --- minimal project creation

**Status: working and under validation.**

A new project contains:

``` text
Project.inform/
├── Source/story.ni
├── uuid.txt
└── .informant.json
```

The UUID must contain no trailing whitespace.

### Stage C --- toolchain discovery

**Status: initial support implemented.**

Informant recognizes the packaged layout:

``` text
PACKAGE/Compilers/
```

### Stage D --- compiler integration

Replace the generic single-command build with the proven:

``` text
inform7 → inform6 → inblorb
```

pipeline.

Initial success criterion:

> Create a fresh project entirely in Informant and produce a valid
> `Build/output.gblorb`.

Stronger validation criterion:

> Compile Cromagnon through Informant using the packaged toolchain and
> compare the resulting output against the established baseline.

### Stage E --- static documentation

Render generated Inform documentation inside a VS Code Webview with
correct resources and navigation.

No paste/create-project bridge is required initially.

### Stage F --- richer HTML/IDE compatibility

Add selected host actions such as `window.Project` behavior after static
rendering is dependable.

### Stage G --- play integration

Improve story execution/interpreter support and integrate it cleanly
with the build workflow.

### Stage H --- Lantern integration

Lantern is a future AI participant/presentation layer.

Inform remains authoritative for canonical game-world state.

Lantern may later contribute:

-   conversational character interaction;
-   generative presentation;
-   images;
-   maps;
-   audio;
-   other AI-assisted experiences.

Lantern should not be mixed into compiler or documentation milestones
prematurely.

## 25. Possible future toolchain extension

A future refinement could separate the platform-specific compiler
package into its own VS Code extension:

``` text
GitHub Actions toolchain builds
            ↓
platform-specific compiler package
            ↓
Inform 7 Toolchain VS Code extension
            ↓
         Informant
```

This could allow:

-   Informant itself to remain largely platform-independent;
-   other VS Code tooling to reuse the same compiler package;
-   compiler versions to evolve independently from IDE behavior.

This is an architectural option, not a current requirement.

The pragmatic order is to make Informant work with the packaged compiler
first and split the package later only if doing so provides a clear
benefit.

## 26. Vimformant contingency concept

A minimal Vim-based fallback environment, informally referred to as
**Vimformant**, may eventually consume the same CI-generated toolchain
packages.

Its purpose would be resilience and portability rather than feature
parity with Informant.

A minimal scope could be:

``` text
editor
build
documentation
run
```

A terminal-oriented documentation transformation could also replace
decorative image controls with text equivalents where useful.

This concept is intentionally deferred until Informant itself is
established.

Its architectural value today is that it reinforces an important
boundary:

> The compiler package and Inform project format should remain useful
> independently of VS Code.

## 27. Why compatibility details are documented

Tool integration often depends on small conventions that are easy to
miss when looking only at high-level behavior.

The `uuid.txt` newline behavior is a useful example: the UUID itself can
be syntactically valid while the surrounding file representation still
affects a later build stage.

Recording these observations gives future contributors a tested starting
point and reduces the chance that compatibility knowledge is lost during
refactoring.

Where practical, Informant should turn such discoveries into:

-   concise architecture notes;
-   comments next to non-obvious code;
-   reproducible tests;
-   explicit project and toolchain contracts.

## 28. Engineering guidance

During development:

-   prefer incremental, reviewable changes;
-   avoid speculative refactoring;
-   preserve working behavior while adding new functionality;
-   keep Inform projects portable;
-   keep Informant-specific metadata minimal;
-   use the proven compiler package rather than duplicating compiler
    logic;
-   keep build failures observable through logs and diagnostics;
-   distinguish persistent project requirements from generated build
    state;
-   preserve non-obvious compatibility behavior with comments or tests;
-   avoid adding dependencies when Node.js or VS Code already provides
    the needed facility;
-   make static documentation reliable before implementing interactive
    documentation APIs;
-   favor reproducibility and explicit behavior over hidden convenience
    mechanisms.

The project should remain understandable to someone debugging or
extending it years later.

## 29. Long-term architectural objective

Informant is not intended to redefine the Inform language or project
format.

Its role is to provide a dependable modern environment around the
existing Inform toolchain while keeping the boundaries between source,
compiler, editor, documentation, and future presentation layers clear.

A successful Informant architecture should make it easier for future
developers to understand how these pieces connect, reproduce the build
environment, and create additional tooling without having to rediscover
integration details that have already been established.
