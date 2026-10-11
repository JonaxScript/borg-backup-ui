#!/usr/bin/env python3
"""Validate maintained documentation links/assets and offline deployment layout."""
from pathlib import Path
import re
import unicodedata
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]


def headings(markdown: str) -> set[str]:
    """Return GitHub-compatible heading IDs, including numbered duplicates."""
    seen = set()
    fenced = False
    for line in markdown.splitlines():
        if line.strip().startswith("```"):
            fenced = not fenced
        if fenced:
            continue
        match = re.match(r"^#{1,6}\s+(.+)$", line)
        if not match:
            continue
        text = re.sub(r"[`*]", "", match[1]).lower()
        base = "".join(c for c in text if c.isspace() or c in "_-" or unicodedata.category(c)[0] in "LNM")
        base = re.sub(r"\s", "-", base)
        slug, suffix = base, 1
        while slug in seen:
            slug = f"{base}-{suffix}"
            suffix += 1
        seen.add(slug)
    return seen


def check_links(files: list[Path], *, boundary: Path) -> list[str]:
    """Check local Markdown references, fragments and assets inside a boundary.

    HTTP(S)/mailto links are not fetched. Fenced examples are excluded. Returns
    diagnostics instead of stopping at the first error.
    """
    errors = []
    for path in files:
        text = re.sub(r"```[^\n]*\n.*?```", "", path.read_text(), flags=re.S)
        for target in re.findall(r"!?\[[^\]]*\]\(([^)\s]+)\)", text):
            parts = urlsplit(target)
            if parts.scheme or parts.netloc:
                continue
            destination = (path.parent / unquote(parts.path)).resolve() if parts.path else path.resolve()
            if not destination.is_relative_to(boundary.resolve()):
                errors.append(f"{path}: outside documentation boundary: {target}")
            elif not destination.exists():
                errors.append(f"{path}: missing target: {target}")
            elif parts.fragment and destination.suffix == '.md':
                if unquote(parts.fragment) not in headings(destination.read_text()):
                    errors.append(f"{path}: missing heading: {target}")
    return errors


def source_files() -> list[Path]:
    """Return the user-facing documentation inventory covered by this audit."""
    return [ROOT / 'README.md', ROOT / 'docs/README.md',
            ROOT / 'ui/docs/help.md', ROOT / 'ui/docs/help.en.md',
            *sorted((ROOT / 'docs/user-manual').rglob('*.md')),
            *sorted((ROOT / 'docs/integrations').glob('*.md')),
            *sorted((ROOT / 'docs/examples/job-hooks').glob('*.md')),
            ROOT / 'docs/auth-user-store-recovery.md']


if __name__ == '__main__':
    findings = check_links(source_files(), boundary=ROOT)
    print('\n'.join(findings) if findings else 'Documentation source links and assets: OK')
    raise SystemExit(bool(findings))
