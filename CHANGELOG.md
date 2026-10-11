## 0.1.3

- Lowered the VS Code engine requirement to 1.96.0 so Informant installs on VS Code 1.96.4.
- Project creation continues to use the VS Code workspace filesystem API and standard `vscode.openFolder` behavior.

## 0.1.2

- Fixed project creation by using VS Code workspace filesystem APIs.
- Verifies `Source/story.ni` and `.informant.json` after creation.
- Shows the exact created project path and offers Open Project or Reveal Folder.
- Fixed project opening to use the supported `vscode.openFolder` arguments.

# Changelog

## 0.1.1

- Added a native **Informant: New Project** workflow.
- Added **Inform 7 Story Project** as the first project type.
- Creates a standard `.inform` project with `Source/story.ni`, `Materials/`, and `Extensions/`.
- Adds project-local `.informant.json` metadata.
- Protects against overwriting an existing non-empty project folder.
- Added **Informant: Open Project** with basic Inform project validation.
- Added New/Open project commands to the Command Palette and File menus.

## 0.1.0

Initial Informant revision.

- Renamed the project from the Vimform7-inspired prototype to Informant.
- Removed Vimform7-specific commands and settings.
- Added private toolchain storage under VS Code extension global storage.
- Added toolchain import from folders and archives.
- Added optional SHA-256-verified toolchain download manifest support.
- Added project-level `.informant.json` toolchain selection.
- Added Informant command namespace and settings namespace.
- Kept language support, snippets, build diagnostics, project creation, documentation opening, extension installation, clean, and play commands.

## 0.1.4

- Replaced the chained New Project prompts with a single Informant project-creation panel.
- Added project type, story title, author, destination, project-path preview, and open-after-create controls in one coherent form.
- Added a native VS Code folder picker behind the Browse button while preserving the verified `workspace.fs` project creation logic.
- Kept VS Code 1.96 compatibility.
