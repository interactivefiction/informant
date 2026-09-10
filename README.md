# Informant

**Informant** is a self-contained Inform development environment for Visual Studio Code.

It is not a Vimform7 port. It is the spiritual successor to Vimform7's main idea: install one dependable package, open an Inform project, write, compile, test, and play without depending on or disturbing whatever Inform installation may already exist on the machine.

## Revision 0.1.1 status

This is an early development build. It already provides:

- Inform 7 language registration for `.ni` and `.i7x` files.
- Syntax highlighting and snippets.
- Native project creation/opening: `Informant: New Project` creates a standard `.inform` folder with `Source/story.ni`, `Materials/`, `Extensions/`, and project-local Informant metadata.
- Build output through a native VS Code output channel.
- Compiler diagnostics in VS Code Problems, with jump-to-source support.
- Private toolchain storage under VS Code's extension global storage.
- Toolchain import from an existing folder.
- Toolchain import from `.zip`, `.tar`, `.tar.gz`, or `.tgz` archives.
- Optional SHA-256-verified downloads from a configured toolchain manifest URL.
- Project-level `.informant.json` selection of toolchain version.
- Play-latest-build command with private interpreter discovery.
- Documentation opener.
- `.i7x` extension copying into either the active project or a configured extensions folder.

It does **not** yet ship with compiler binaries. The important change in this revision is that Informant now has the architecture to own compiler/interpreter toolchains privately.

## Design principle

Informant should not require `sudo`, should not write into `/usr/local`, should not modify the user's PATH, and should not replace or depend on a system Inform installation.

Private toolchains live in VS Code extension global storage, conceptually like this:

```text
<globalStorage>/toolchains/
    inform-10.2.0-linux-x64/
        bin/
            inform7
            inform6
            inbuild
            inter
            inblorb
            glulxe
```

Each project may choose a toolchain in `.informant.json`:

```json
{
  "toolchainVersion": "inform-10.2.0-linux-x64"
}
```

## Commands

- `Informant: Compile Story`
- `Informant: Compile and Play`
- `Informant: Play Story`
- `Informant: Test Story`
- `Informant: Show Build Errors`
- `Informant: New Project`
- `Informant: Open Project`
- `Informant: Install .i7x Extension`
- `Informant: Clean Project`
- `Informant: Install Toolchain`
- `Informant: Manage Toolchains`
- `Informant: Select Project Toolchain`
- `Informant: Reveal Informant Storage`

## First-run workflow

1. Install the VSIX.
2. Run `Informant: New Project`.
3. Choose **Inform 7 Story Project**, enter the story title and author, and choose a parent folder.
4. Informant creates `<Story Title>.inform/Source/story.ni` and opens the new project as the VS Code workspace.
5. Edit `Source/story.ni` and save normally with VS Code (`Ctrl+S` / `Cmd+S`).
6. Later, use `Informant: Open Project` and choose the `.inform` folder to continue writing.
7. Compilation still requires a private toolchain; use `Informant: Install Toolchain` when ready.

## Toolchain downloads

The setting `informant.toolchain.manifestUrl` can point to a JSON manifest with entries like:

```json
{
  "toolchains": [
    {
      "id": "inform-10.2.0-linux-x64",
      "version": "10.2.0",
      "platform": "linux-x64",
      "url": "https://example.invalid/inform-10.2.0-linux-x64.tar.gz",
      "sha256": "..."
    }
  ]
}
```

A later revision should publish real Informant toolchain artifacts for Linux, Windows, and macOS.

## Build command template

The default compile command is:

```text
{inform7} -project {project}
```

You can change it with `informant.build.commandTemplate` if a specific toolchain requires a different command line. Supported tokens:

- `{project}`
- `{toolchain}`
- `{inform7}`
- `{inform6}`
- `{inbuild}`
- `{inter}`
- `{inblorb}`

## Development

```bash
node --check extension.js
```

This repository is intentionally plain JavaScript for now so it stays easy to inspect and hack on.

### New Project dialog

Run **Informant: Create New Project** to open a single project-creation form. Choose the project type, title, author, and destination, then create the project. Informant creates the standard `.inform/Source/story.ni` structure and can open it immediately.
