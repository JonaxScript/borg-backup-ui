#!/usr/bin/env python3
"""Copy canonical manuals and their offline dependencies into a staged app.

No package is built here. The caller supplies the repository root and an existing
staged application directory. Missing inputs or copy failures propagate.
"""
from pathlib import Path
import shutil
import sys


def package_documentation(repository: Path, application: Path) -> None:
    """Copy maintained documentation without publishing or changing source files.

    Existing staged files are replaced. Only the explicit documentation trees
    below are copied; maintainer notes and other workspace files are excluded.
    """
    destination = application / "ui" / "docs"
    source = repository / "docs" / "user-manual"
    destination.mkdir(parents=True, exist_ok=True)
    # Source links work on GitHub; the generated package uses its offline layout.
    for filename in ("help.md", "help.en.md"):
        text = (repository / "ui" / "docs" / filename).read_text(encoding="utf-8")
        (destination / filename).write_text(
            text.replace("](../../docs/user-manual/", "](manual/"), encoding="utf-8"
        )
    for language in ("de", "en"):
        target = destination / "manual" / language
        target.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / language / "user-manual.md", target)
    shutil.copytree(source / "assets", destination / "manual" / "assets", dirs_exist_ok=True)
    shutil.copy2(source / "apprise-providers.md", destination / "manual")
    for relative in ("integrations", "examples/job-hooks"):
        shutil.copytree(repository / "docs" / relative, destination / relative, dirs_exist_ok=True)
    shutil.copy2(repository / "docs" / "auth-user-store-recovery.md", destination)


if __name__ == "__main__":
    package_documentation(Path(sys.argv[1]), Path(sys.argv[2]))
