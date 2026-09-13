# Clone response failures

Clone HTTP responses are read as text before JSON decoding. Non-JSON, empty and
invalid-shaped responses report the HTTP status, content type and a sanitized,
limited response excerpt. Provider JSON errors keep their message. Successful
submissions require a nonempty string request ID. Submission POSTs are never
blindly retried; an uncertain intent remains blocked for operator reconciliation.
This prevents accidentally creating a second VM after a lost acceptance response.

Early ticket provisioning failures now resolve the project owner when no user ID
was passed, so terminal status is broadcast instead of only being stored. Unknown
clone outcomes give reconciliation guidance instead of claiming a sandbox exists
and recommending another build.

Validation covers HTML, empty, invalid JSON shapes, provider JSON errors, secret
redaction, successful acceptance, single POST behavior and pending clone resumption.
This fixes LFG diagnostics and status delivery; it does not establish or repair the
upstream cause of the previously received non-JSON response. No live clone was
submitted during local verification.
