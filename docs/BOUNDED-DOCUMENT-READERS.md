# CAP bounded document readers

`read_spreadsheet` and `read_document` use CAP-authored, pure-Python readers packaged as local wheels (`cap_xlsx_reader`, `cap_docx_reader`, `cap_pptx_reader`). They are **not general Office parsers or third-party package distributions**. The pins in `extension/lib/python-documents-bundle.js` detect changes to CAP's locally generated wheel bytes; they do not attest external provenance. Only the fixed document-tool runtime receives these modules; model-authored Python does not.

## Supported extraction

- **XLSX:** Declared worksheet targets (relative to the workbook or package-root absolute), shared/inline strings, unstyled numbers, booleans and plain text. Every declared sheet must be present; a successful read creates one canonical tabular artifact containing every parsed sheet. The response previews at most ten rows; `previewTruncated` means only that the *preview* is short, not that the artifact is partial.
- **DOCX:** The body paragraphs and simple tables in their source order, with common heading and list styles rendered as Markdown. Formatting and layout are not reproduced.
- **PPTX:** Direct text shapes in slide XML, with title and bullet text rendered as Markdown. Where a presentation manifest exists, its slide relationships determine order; minimal packages without one use numeric slide-part order. Decorative geometry and layout are not reproduced.

## Limits and refusal

Base64 transport is capped at 256 KiB. Individual shared-string, worksheet, DOCX-body and slide XML members are capped at 10 MiB **uncompressed**; XLSX parsing is capped at 5,000 rows and 100 columns. `read_spreadsheet.maxRows` is an additional caller cap; `read_document.maxCharacters` is capped at 500,000. These are admission limits, not a promise to truncate and return a plausible partial result.

Unknown or duplicate package parts and unsupported content—including spreadsheet formulas, styled/date cells, error cells, comments, charts, drawings and linked content; DOCX annotations, alternate content, headers, nested tables or attachments; and presentation pictures, groups, charts, media or notes—must return `{ ok: false, incomplete: true, error: "document_incomplete: ..." }`. Exceeding a parsing or output limit has the same explicit incomplete result. No partial spreadsheet artifact or document body is returned. Transport over-limit and a missing Python runtime have separate explicit errors; malformed archives fail rather than being represented as successful documents.

**Scope:** These readers target deliberately limited text/table subsets. An Office file needing an unsupported feature is refused; callers must use another workflow rather than treating a partial extract as complete. The original pure-Python assumption cannot be used as a claim of broad compatibility.
