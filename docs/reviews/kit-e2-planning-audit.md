# KIT-E2 planning audit

Reviewed the saved chat, both stored documents, and all nine implementation tickets (KIT-2–KIT-10) on 2026-09-24. This is an audit; the saved product scope and tickets have not been rewritten.

## Findings

| Issue | Evidence | Correction needed |
|---|---|---|
| Voiceover deferred without a targeted scope decision | User selected silent, uploaded music AND AI voiceover. PRD excludes voiceover; KIT-8 explicitly prohibits TTS. Agent disclosed the deferral later, followed by a generic build approval. | Ask specifically whether voiceover belongs in v1. Do not treat the original selection as a request to defer it. |
| Architecture recommended, not jointly selected | Chat recommends FFmpeg in Docker; PRD decision 2 and Technical Analysis treat alternatives as rejected. No choice/delegation is recorded before document creation. | Discuss in-app rendering, a separate worker/container, library requirements and hosted rendering where viable, then record the chosen approach. |
| Music size policy conflicts | PRD requirement 10 says oversized/long audio should be trimmed, not rejected. KIT-8 requires rejecting oversized uploads (example 25MB cap). | Separate upload byte limit from track duration, agree the limit and update both documents and checks. |
| Earlier videos kept but unreachable | PRD 13/16 preserve earlier successful results. KIT-3 allows multiple rows; KIT-6 exposes latest-by-post routes only; KIT-7 has no history selector. | Add owner-checked access by render ID and a previous-results UI, or explicitly revise the retention promise. |
| First step cannot satisfy its own checks | KIT-2 excludes routes, but acceptance requires endpoints to return unavailable responses. It also specifies Service.available before the service is created in KIT-5. | Keep KIT-2 checks to packaging/config/capability; move HTTP checks to KIT-6 and make the capability helper independent. |
| Audio truncation is unresolved across steps | Technical Analysis and KIT-4 prescribe -shortest. KIT-8 warns this can truncate the video for short tracks and proposes padding. | Specify one consistent duration policy and test short, long and absent audio at the renderer level. |
| Unmeasurable acceptance wording | KIT-5 requires the file to be “at least twice playable size-wise” without defining a unit or threshold. | Replace with decoded stream, expected dimensions/frame rate, duration tolerance, and playback checks. |
| Local-only deployments conflict with acceptance | Technical Analysis says S3 storage when configured. KIT-5 acceptance requires local_path AND S3 fields. | Test local-only and S3-enabled storage separately; require the configured output to be retrievable. |
| No-cropping promise conflicts with motion | PRD promises nothing cropped/letterboxed while prescribing zoom; KIT-4 permits padding for unexpected dimensions and zoom to 1.08. | Define safe margins and intended visual treatment, rather than promise zero cropping for zoomed slides. |
| Decisions remain listed as open after being scoped | PRD leaves TikTok-only, previous-result retention and motion variety open; user explicitly selected TikTok-only and documents/tickets prescribe the latter behaviors. | Separate agreed decisions, proposed defaults and genuinely unresolved questions. |

## Why the tickets feel confusing

They are implementation-layer slices rather than independently usable feature increments. That can work internally, but prerequisites and completion boundaries must be explicit. Nine long instruction sets mix exact code choices, later-step behavior, optional examples, and acceptance requirements. Keep the chat at feature level; make internal steps concise and consistent with approved documents.

## Failure report correction

The agent later hypothesized that pulling the FFmpeg image caused the failure. The executor logs inspected in this task instead show Git setup failing because it could not enter /data. This happened before implementation; it is not evidence against the rendering architecture. The code now creates the checkout parent before Git setup. A successful full feature build has not been verified.

## Plain-language sections to add after scope is resolved

PRD: what is being built; the user's path from opening an existing carousel, choosing sound/timing, generating, watching progress, previewing, downloading/publishing, and finding previous results; empty/error/retry states and mobile layout.

Technical Analysis: the same journey behind the scenes, where rendering runs, what runtime dependencies it needs, where files are stored, how jobs recover, what it costs, and which choices the user approved. Do not claim zero operating cost merely because there is no per-render provider fee.

## Next decision

Resolve the rendering approach and voiceover scope before resuming the build. Then update the PRD and Technical Analysis together and reconcile the internal work plan against the agreed requirements. Do not silently retrofit approval into existing documents.
