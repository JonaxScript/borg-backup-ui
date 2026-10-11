# Documentation maintenance

## Sources and scope

`docs/user-manual/{de,en}/user-manual.md` are the canonical manuals. Do not
maintain independent generated full-text copies. `ui/docs/help{,.en}.md` are
short operational summaries. `plugin/package_documentation.py` copies manuals,
images and explicit companions into the existing offline help tree. Quick-help
links use repository-relative paths in source and are rewritten for that tree
during packaging. Add every new package input to the source-digest inventory
in `plugin/release_workflow.py`.

Use four entry routes: tutorial, tasks, reference and concepts. Keep numbered
menu-reference headings and public paths stable. Add tasks through entry links
rather than duplicating explanations. Historical UI proposals belong in
`help-improvements.md`; evidence and open gaps belong in the audit, not in a
newcomer's workflow.

## Language and task template

German uses Sie, proper umlauts and actual German UI labels. English uses natural
English and actual English labels. Product terms: storage target / Speicherziel,
profile / Profil, repository / Repository, job / Job, archive / Archiv, archive
prefix / Archivpräfix, permanent Job ID / dauerhafte Job-ID. A restore test is
technical evidence with a stated scope, not guaranteed application recovery.

Every substantial procedure contains: outcome, prerequisites/role, risks and
needed backup, numbered UI steps, expected visible result, concrete verification,
common failure and related reference. State destructive effects before the step.
Distinguish source behavior, intended behavior and limitations. Do not infer
behavior from labels, comments or tests without reading executable code.

Update both languages in one change. Review semantic parity by procedure and
warning, not line count. Keep terminology, defaults, limits, roles, export schema
and evidence scope aligned. Retain useful details when shortening paragraphs.

## Versions and screenshots

Record inspected commit, published manifest/package provenance, test-only changes
and image capture baseline separately. Never update an image date because text
changed. Historic workaround headings can remain as compatibility anchors, but
explain applicable versions in the body. Normal tasks contain no issue narrative.

Use real UI captures with synthetic data in both languages, matching theme,
viewport and crop. Never generate replacement UI or expose secrets/private paths.
If Unraid, devices or a suitable demo are unavailable, record the exact image gap
and label historical images. Dimensions/file existence do not prove visual accuracy.

## Feature review checklist

For each behavior change record authoritative code/UI, German section, English
section, short-help topic, screenshot decision and evidence status in a coverage
matrix (see [audit #560](documentation-audit-560.md)). Separate code inspection,
static checks, executed integration tests and pending host checks. In particular
revisit restore evidence, deletion scope, exports and recovery whenever their
implementation changes.

## Reproducible checks

Run from the repository, with temporary test data inside it:

```bash
python3 plugin/documentation_audit.py
node tests/help_markdown.cjs
python3 -m pytest tests/test_documentation.py tests/test_i18n_resources.py tests/test_remaining_ui_redesign.py --basetemp=.release-tmp/docs-pytest
```

The checks validate links/anchors/assets, package the actual dependency tree,
execute the renderer with safety/structure cases, verify semantic contracts and
check both language resources. They cannot prove prose completeness or a working
Unraid restore. Manually review light/dark, narrow/desktop, TOC, search, language
switch, view switch, companion documents and images. Use an isolated Borg repo
for command checks; a complete Unraid tutorial and recovery still need a host.

The supported Markdown subset is headings, paragraphs, fenced code, nested
ordered/unordered lists, pipe tables, links, images and note/warning callouts.
Raw HTML stays escaped. Use simple heading text, normal relative links and no
external runtime assets. External links display an arrow; routine workflows must
not depend on opening them. Check GitHub preview separately when available.

Shipped help, renderer and packaging changes follow the normal issue, bot,
release-note, final pushed-commit preflight and test-channel workflow. A passing
documentation test is no exemption from [release gates](release-workflow.md).
