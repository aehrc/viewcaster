# Security policy

Copyright © 2026, Commonwealth Scientific and Industrial Research Organisation
(CSIRO) ABN 41 687 119 230.

## Supported versions

Security fixes are applied to the latest released version only.

## Reporting a vulnerability

Do not report security vulnerabilities through public GitHub issues.

Report them privately using [GitHub private vulnerability
reporting](https://github.com/aehrc/viewcaster/security/advisories/new), or by
email to [John.Grimes@csiro.au](mailto:John.Grimes@csiro.au).

Include, where possible:

- the affected version and environment (Oracle Database version, Node.js
  version, storage mode);
- a description of the issue and its impact;
- steps or a ViewDefinition that reproduces it.

You should receive an acknowledgement within five working days. Please do not
disclose the issue publicly until a fix has been released.

## Scope

viewcaster generates SQL from ViewDefinitions and writes FHIR resources to a
database. Treat ViewDefinitions as untrusted input only when they come from
untrusted sources: reports of SQL injection through ViewDefinition content,
credential leakage in logs or output, or generated SQL that reads data outside
the configured table are in scope.

Findings in Oracle Database itself, or in third party dependencies, should be
reported to their respective maintainers.
