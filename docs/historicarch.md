# Informant Architecture and Compatibility Notes

## Purpose

Informant is a modern development environment for Inform 7, initially
implemented as a Visual Studio Code extension.

This document records practical integration details discovered while
developing Informant. Its purpose is to make those details explicit and
reproducible for future contributors and for anyone interested in
building tooling around Inform.

Informant builds on the work of the Inform project, its IDEs, and
earlier community tooling. Where Informant behaves differently from an
existing IDE, that should be understood as a design choice for this
project rather than a criticism of another implementation.

## Guiding principle

An Informant project should remain a normal Inform project.

Informant should preserve the conventional `.inform` project structure
and avoid making source material dependent on Informant-specific
machinery. If Informant or VS Code is unavailable, the project's Inform
source should remain usable by other compatible Inform tooling.

Informant-specific state should therefore be kept separate and minimal.

## Minimum project structure

For a newly created Informant story project, the intended initial
structure is:

``` text
MyProject.inform/
├── Source/
│   └── story.ni
├── uuid.txt
└── .informant.json
```

`Source/story.ni` is the canonical Inform source.

`.informant.json` contains Informant-specific project metadata, such as
project type and selected toolchain information.

`uuid.txt` contains the Inform story identifier and is required for a
valid build.

Other directories and generated files should be created by the Inform
toolchain when appropriate rather than pre-created merely to resemble
the working state of another IDE.

## Comparison with existing project layouts

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

These files support the complete IDE experience, including build
products, indexes, notes, settings, and skein state.

Earlier Vimform7 tooling demonstrated that a considerably smaller
project can still participate in the Inform toolchain. Informant uses
that experience as a useful compatibility reference while defining its
own minimal project contract.

Informant does not need to reproduce IDE session/state files unless a
future feature specifically requires them.

## Generated directories

`Build/` and `Index/` are generated as part of Inform processing and do
not need to exist when Informant first creates a project.

Likewise, materials support should follow Inform's project conventions
rather than creating an arbitrary `Materials/` directory inside the
`.inform` directory.

The project creator should therefore avoid creating empty directories
that are not required before compilation.

## `uuid.txt`: important compatibility detail

The contents of `uuid.txt` require special care.

A valid example is:

``` text
16358557-fb4e-46ca-975d-63c389a7c986
```

The contemporary Inform IDE has been observed generating a version 4
UUID. Informant can therefore generate the identifier with Node.js's
built-in:

``` javascript
crypto.randomUUID()
```

No external UUID package is required.

### No trailing newline

`uuid.txt` must contain the UUID characters only.

Do **not** append a newline or other whitespace:

``` javascript
await vscode.workspace.fs.writeFile(
    uuidUri,
    Buffer.from(crypto.randomUUID(), 'utf8')
);
```

In testing, writing the otherwise-valid UUID with a trailing newline
caused that newline to propagate into generated `Release.blurb` content.
The resulting IFID placeholder was split across lines, and `inblorb`
reported errors similar to:

``` text
Release.blurb, line 21: Error: not a valid blurb command
Release.blurb, line 22: Error: not a valid blurb command
```

This is easy to overlook because many text-writing utilities
conventionally terminate a text file with a newline, and the UUID
appears visually correct in a normal editor.

For Informant, the project-format rule is therefore:

``` text
uuid.txt = UUID only, with no trailing whitespace
```

A code comment near UUID creation is recommended so this behavior is not
accidentally "normalized" by a future cleanup.

For example:

``` javascript
// Inform consumes uuid.txt without trimming trailing whitespace.
// Do not append a newline: it can propagate into Release.blurb
// and make the generated IFID invalid for inblorb.
```

## Toolchain package

The known working Informant toolchain package has the following shape:

``` text
PACKAGE/
├── Compilers/
│   ├── inform7
│   ├── inform6
│   └── inblorb
└── [Inform Internal resources]
```

The package root is significant because `inform7` receives it through
the `-internal` argument.

The `Compilers` directory contains the executable tools, while the
package root contains the corresponding Inform resources.

Informant's toolchain discovery supports this package structure.

## Proven build sequence

The build process currently being integrated into Informant is based on
a command sequence already exercised successfully outside the extension.

### Stage 1 --- Inform 7

``` text
<Compilers>/inform7 -internal <toolchain-root> -format=ulx -project "<project>" -release
```

This performs the Inform 7 compilation stage and produces intermediate
material including:

``` text
<project>/Build/auto.inf
```

### Stage 2 --- Inform 6

The known working command is based on:

``` text
<Compilers>/inform6 -wxE2~S~DG <huge-option> "<project>/Build/auto.inf" "<project>/Build/output.ulx"
```

The exact handling of the existing `huge` option should be preserved
from the proven build environment rather than guessed.

This produces:

``` text
<project>/Build/output.ulx
```

### Stage 3 --- Inblorb

``` text
<Compilers>/inblorb "<project>/Release.blurb" "<project>/Build/output.gblorb"
```

This produces the packaged story:

``` text
<project>/Build/output.gblorb
```

The resulting pipeline is:

``` text
Source/story.ni
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

## Build implementation philosophy

Informant should execute the compiler stages directly rather than
requiring Make as part of the extension runtime.

Direct execution allows the extension to:

-   report which compiler stage is running;
-   capture stdout and stderr for each stage;
-   stop cleanly when a stage fails;
-   translate compiler messages into VS Code diagnostics;
-   locate executables through Informant's selected toolchain;
-   avoid adding Make as another runtime requirement.

A Makefile can still be useful for development, testing, documentation,
or an independent command-line workflow. It simply should not be
required for Informant's Build command.

## Toolchain versus project responsibilities

It is useful to keep these responsibilities distinct.

The project supplies persistent story identity and source material:

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

The build process produces transient/generated artifacts such as:

``` text
Build/
Index/
Release.blurb
output.ulx
output.gblorb
```

This distinction helps prevent generated state from becoming part of
Informant's required source-project format.

## Compatibility methodology

When the expected behavior is unclear, Informant development uses
several complementary references:

1.  Projects created by the current Inform IDE show the complete
    contemporary IDE representation.
2.  The Inform compiler/toolchain source establishes compiler behavior.
3.  Vimform7 provides a historical record of a small, independently
    implemented Inform workflow and contains useful lessons from
    practical compatibility work.
4.  Actual compilation tests establish which assumptions hold for the
    packaged Inform version used by Informant.

No single reference needs to dictate Informant's entire design. The goal
is to identify the smallest dependable contract that interoperates well
with Inform.

## Why these details are documented

Tool integration often depends on small conventions that are easy to
miss when looking only at high-level compiler documentation.

The `uuid.txt` newline behavior is a useful example: the UUID can be
syntactically valid while the surrounding file representation still
affects a later build stage.

Recording these observations gives future contributors a tested starting
point and reduces the chance that compatibility knowledge is lost during
refactoring.

Where possible, Informant should turn such discoveries into:

-   concise architecture notes;
-   small comments next to non-obvious code;
-   reproducible tests;
-   explicit project/toolchain contracts.

## Documentation integration

Inform's generated documentation behaves like a small website rather
than a collection of unrelated HTML files.

A representative layout is:

``` text
documentation-root/
├── book/
│   ├── RB_*.html
│   ├── WI_*.html
│   └── ...
└── assets/
    └── images/
        └── doc_images/
```

Pages may contain root-relative resource references such as:

``` text
/assets/images/doc_images/arrow-left.png
```

Informant's future static documentation Webview should preserve this
site-root relationship by translating local resources into Webview-safe
URIs.

The initial documentation milestone should focus on faithful static
rendering and navigation.

## Documentation host integration

Some generated documentation contains JavaScript that expects a
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

These can eventually be mapped to VS Code Webview messages, but they are
not required for the initial static documentation viewer.

This is another example of an integration contract worth documenting
separately from the documentation content itself.

## Reproducibility

The Informant toolchain has been validated by compiling a substantial
existing Inform project with both the packaged toolchain and an
established Inform environment.

The resulting ULX output was byte-for-byte identical in that validation.

This supports an important Informant objective: build behavior should be
reproducible and based on a known toolchain rather than on whatever
Inform installation happens to be available on the host system.

## Current development order

The current implementation order is intentionally incremental:

``` text
1. Correct minimal project creation
2. Reliable toolchain discovery
3. Explicit inform7 → inform6 → inblorb build
4. Static Inform documentation
5. Richer documentation/IDE integration
6. Playback improvements
7. Later integrations such as Lantern
```

Each stage should be tested before adding the next.

## General contributor guidance

When modifying Informant:

-   preserve standard Inform project compatibility;
-   keep Informant-specific metadata minimal;
-   prefer small, reviewable changes;
-   avoid introducing dependencies when platform/runtime facilities
    already suffice;
-   do not assume generated files exist in a fresh project;
-   distinguish source/project requirements from IDE state and generated
    build artifacts;
-   preserve non-obvious compatibility behavior with comments or tests;
-   use observed behavior and reproducible tests when an integration
    detail is uncertain.

The objective is not to duplicate every implementation detail of an
existing Inform IDE. It is to provide a dependable modern environment
that works cooperatively with the Inform ecosystem and respects the
conventions established by the Inform toolchain.
